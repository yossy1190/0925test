/**
 * セサミ（SESAME）閉め忘れ監視スクリプト for Google Apps Script
 *
 * 概要:
 *   Sesame Web API (https://app.candyhouse.co/api/sesame2/{UUID}) を叩いて
 *   施錠状態を取得し、「解錠(unlocked)」のときだけ LINE へ警告を飛ばす。
 *
 * 前提:
 *   - セサミ本体に「Wi-Fiモジュール2 (WM2)」が接続されていること。
 *     Bluetoothのみの構成ではクラウドから状態を取得できません。
 *   - APIキー・UUID・LINEのトークンはすべてスクリプトプロパティから読み込みます
 *     （コード内に直書きしない）。
 *
 * 使い方:
 *   1. setupProperties() のコメントを読んでスクリプトプロパティを設定
 *   2. testFetchStatus()  … APIから状態が取れるか確認
 *   3. testNotify()       … LINEに届くか確認
 *   4. createDailyTrigger() … 毎日23時のトリガーを自動作成
 *   5. 以降は checkSesameLock() がトリガーで自動実行される
 */

// ===================== 定数 =====================

/** Sesame Web API のベースURL（末尾スラッシュあり） */
var SESAME_API_BASE = 'https://app.candyhouse.co/api/sesame2/';

/** LINE Messaging API プッシュ送信エンドポイント */
var LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

/** LINE Notify エンドポイント（※2025-03-31にサービス終了済み。互換のため残置） */
var LINE_NOTIFY_ENDPOINT = 'https://notify-api.line.me/api/notify';

/** スクリプトプロパティのキー定義 */
var PROP = {
  SESAME_API_KEY:            'SESAME_API_KEY',            // 必須: CandyHouse の API キー
  SESAME_DEVICE_UUID:        'SESAME_DEVICE_UUID',        // 必須: デバイスUUID
  DEVICE_LABEL:              'DEVICE_LABEL',              // 任意: 表示名（既定「玄関」）
  NOTIFIER:                  'NOTIFIER',                  // 任意: 'messaging'(既定) | 'notify'
  LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN', // Messaging API 用
  LINE_TO:                   'LINE_TO',                   // Messaging API 用: 送信先ユーザーID
  LINE_NOTIFY_TOKEN:         'LINE_NOTIFY_TOKEN',         // LINE Notify 用トークン
  TREAT_MOVED_AS_UNLOCKED:   'TREAT_MOVED_AS_UNLOCKED',   // 任意: 'true'(既定) | 'false'
  NOTIFY_ON_UNKNOWN:         'NOTIFY_ON_UNKNOWN',         // 任意: 'true' | 'false'(既定)
  ALERT_COOLDOWN_MINUTES:    'ALERT_COOLDOWN_MINUTES',    // 任意: 連投抑止(分)。既定 60
  LAST_ALERT_AT:             '_LAST_ALERT_AT'             // 内部管理用（手動設定不要）
};

/** 施錠状態の正規化結果 */
var LOCK_STATE = {
  LOCKED:   'LOCKED',   // 施錠済み
  UNLOCKED: 'UNLOCKED', // 解錠（＝閉め忘れ）
  MOVED:    'MOVED',    // 動作途中／半端な位置
  UNKNOWN:  'UNKNOWN'   // 判定不能
};

// ===================== メイン =====================

/**
 * メインエントリポイント。トリガーからはこの関数を呼ぶ。
 */
function checkSesameLock() {
  var cfg;
  try {
    cfg = loadConfig_();
  } catch (e) {
    // 設定不備は通知しようがないのでログのみ
    console.error('設定エラー: ' + e.message);
    throw e;
  }

  var status;
  try {
    status = fetchSesameStatus_(cfg);
  } catch (e) {
    console.error('セサミAPI取得失敗: ' + e.message);
    // 取得自体に失敗した場合は「不明」として扱う
    if (isTrue_(cfg.notifyOnUnknown)) {
      notify_('⚠️セサミの状態を取得できませんでした（' + cfg.deviceLabel + '）\n理由: ' + e.message, cfg);
    }
    throw e;
  }

  var result = interpretLockState_(status);
  console.log('CHSesame2Status=' + JSON.stringify(status.CHSesame2Status) +
              ' → 判定=' + result.state +
              ' / battery=' + status.batteryPercentage + '%' +
              ' / wm2State=' + status.wm2State);

  if (!shouldAlert_(result.state, cfg)) {
    console.log('通知不要（' + result.state + '）');
    return result.state;
  }

  if (isCoolingDown_(cfg)) {
    console.log('クールダウン中のため通知をスキップしました。');
    return result.state;
  }

  notify_(buildAlertMessage_(result, status, cfg), cfg);
  markAlerted_();
  return result.state;
}

// ===================== 設定読み込み =====================

/**
 * スクリプトプロパティから設定を読み込み、必須項目を検証する。
 * @return {Object} 設定オブジェクト
 */
function loadConfig_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    apiKey:       (p.getProperty(PROP.SESAME_API_KEY) || '').trim(),
    uuid:         (p.getProperty(PROP.SESAME_DEVICE_UUID) || '').trim(),
    deviceLabel:  (p.getProperty(PROP.DEVICE_LABEL) || '玄関').trim(),
    notifier:     (p.getProperty(PROP.NOTIFIER) || 'messaging').trim().toLowerCase(),
    channelToken: (p.getProperty(PROP.LINE_CHANNEL_ACCESS_TOKEN) || '').trim(),
    lineTo:       (p.getProperty(PROP.LINE_TO) || '').trim(),
    notifyToken:  (p.getProperty(PROP.LINE_NOTIFY_TOKEN) || '').trim(),
    treatMovedAsUnlocked: (p.getProperty(PROP.TREAT_MOVED_AS_UNLOCKED) || 'true').trim(),
    notifyOnUnknown:      (p.getProperty(PROP.NOTIFY_ON_UNKNOWN) || 'false').trim(),
    cooldownMinutes: parseInt(p.getProperty(PROP.ALERT_COOLDOWN_MINUTES) || '60', 10)
  };

  var missing = [];
  if (!cfg.apiKey) { missing.push(PROP.SESAME_API_KEY); }
  if (!cfg.uuid)   { missing.push(PROP.SESAME_DEVICE_UUID); }

  if (cfg.notifier === 'notify') {
    if (!cfg.notifyToken) { missing.push(PROP.LINE_NOTIFY_TOKEN); }
  } else {
    cfg.notifier = 'messaging';
    if (!cfg.channelToken) { missing.push(PROP.LINE_CHANNEL_ACCESS_TOKEN); }
    if (!cfg.lineTo)       { missing.push(PROP.LINE_TO); }
  }

  if (missing.length) {
    throw new Error('スクリプトプロパティが未設定です: ' + missing.join(', '));
  }
  if (isNaN(cfg.cooldownMinutes) || cfg.cooldownMinutes < 0) {
    cfg.cooldownMinutes = 60;
  }
  return cfg;
}

// ===================== セサミAPI =====================

/**
 * デバイスの現在状態を取得する。
 * GET https://app.candyhouse.co/api/sesame2/{UUID}
 * ヘッダ: x-api-key: <APIキー>
 *
 * 返却例:
 * {
 *   "batteryPercentage": 94,
 *   "batteryVoltage": 5.87,
 *   "position": 11,
 *   "CHSesame2Status": "locked",
 *   "timestamp": 1700000000,
 *   "wm2State": 1
 * }
 *
 * @param {Object} cfg
 * @return {Object} パース済みレスポンス
 */
function fetchSesameStatus_(cfg) {
  var url = SESAME_API_BASE + encodeURIComponent(cfg.uuid);
  var params = {
    method: 'get',
    headers: { 'x-api-key': cfg.apiKey },
    muteHttpExceptions: true,
    followRedirects: true
  };

  var res = fetchWithRetry_(url, params, 3);
  var code = res.getResponseCode();
  var body = res.getContentText();

  if (code === 401 || code === 403) {
    throw new Error('APIキーが不正、またはこのUUIDへの権限がありません (HTTP ' + code + ')');
  }
  if (code === 404) {
    throw new Error('デバイスが見つかりません。UUIDを確認してください (HTTP 404)');
  }
  if (code < 200 || code >= 300) {
    throw new Error('Sesame API エラー HTTP ' + code + ': ' + truncate_(body, 300));
  }

  var json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('レスポンスのJSON解析に失敗: ' + truncate_(body, 300));
  }
  return json;
}

/**
 * ネットワーク／5xx エラー時に指数バックオフでリトライする fetch。
 * @param {string} url
 * @param {Object} params
 * @param {number} maxAttempts
 * @return {HTTPResponse}
 */
function fetchWithRetry_(url, params, maxAttempts) {
  var lastErr = null;
  for (var i = 0; i < maxAttempts; i++) {
    try {
      var res = UrlFetchApp.fetch(url, params);
      var code = res.getResponseCode();
      // 5xx と 429 のみリトライ対象（4xx はリトライしても無駄）
      if (code < 500 && code !== 429) { return res; }
      lastErr = new Error('HTTP ' + code);
    } catch (e) {
      lastErr = e; // 通信断など
    }
    if (i < maxAttempts - 1) {
      Utilities.sleep(Math.pow(2, i) * 1000); // 1s, 2s, 4s...
    }
  }
  throw new Error('リトライしても失敗しました: ' + (lastErr ? lastErr.message : 'unknown'));
}

// ===================== 施錠判定ロジック =====================

/**
 * CHSesame2Status を解釈して施錠状態を正規化する。
 *
 * 【CHSesame2Status の仕様】
 *   Web API が返すのは文字列で、実質的に次の3値。
 *     "locked"   … 施錠済み
 *     "unlocked" … 解錠（＝閉め忘れの対象）
 *     "moved"    … サムターンが中途半端な位置／動作中
 *   ファームウェアやSDKによっては大文字・数値(0=locked,1=unlocked,2=moved)で
 *   返るケースもあるため、両方を吸収して判定する。
 *
 *   なお position（角度）だけで判定してはいけない。取り付け角度により
 *   施錠角度は個体ごとに違うため、必ず CHSesame2Status を正とする。
 *
 * @param {Object} json APIレスポンス
 * @return {{state: string, raw: *}}
 */
function interpretLockState_(json) {
  var raw = (json && typeof json.CHSesame2Status !== 'undefined')
    ? json.CHSesame2Status
    : null;

  // 数値で返る実装への保険
  if (typeof raw === 'number') {
    if (raw === 0) { return { state: LOCK_STATE.LOCKED,   raw: raw }; }
    if (raw === 1) { return { state: LOCK_STATE.UNLOCKED, raw: raw }; }
    if (raw === 2) { return { state: LOCK_STATE.MOVED,    raw: raw }; }
    return { state: LOCK_STATE.UNKNOWN, raw: raw };
  }

  var s = String(raw == null ? '' : raw).trim().toLowerCase();
  switch (s) {
    case 'locked':
      return { state: LOCK_STATE.LOCKED, raw: raw };
    case 'unlocked':
      return { state: LOCK_STATE.UNLOCKED, raw: raw };
    case 'moved':
    case 'moving':
      return { state: LOCK_STATE.MOVED, raw: raw };
    default:
      return { state: LOCK_STATE.UNKNOWN, raw: raw };
  }
}

/**
 * 通知すべき状態かどうか。
 * @param {string} state
 * @param {Object} cfg
 * @return {boolean}
 */
function shouldAlert_(state, cfg) {
  if (state === LOCK_STATE.UNLOCKED) { return true; }
  if (state === LOCK_STATE.MOVED)    { return isTrue_(cfg.treatMovedAsUnlocked); }
  if (state === LOCK_STATE.UNKNOWN)  { return isTrue_(cfg.notifyOnUnknown); }
  return false; // LOCKED
}

/**
 * 通知メッセージを組み立てる。
 * @param {Object} result interpretLockState_ の戻り値
 * @param {Object} status APIレスポンス
 * @param {Object} cfg
 * @return {string}
 */
function buildAlertMessage_(result, status, cfg) {
  var head;
  if (result.state === LOCK_STATE.UNLOCKED) {
    head = '⚠️警告：' + cfg.deviceLabel + 'のセサミが開いたままです！';
  } else if (result.state === LOCK_STATE.MOVED) {
    head = '⚠️警告：' + cfg.deviceLabel + 'のセサミが半端な位置（moved）です！';
  } else {
    head = '⚠️警告：' + cfg.deviceLabel + 'のセサミの状態が判定できません（' + result.raw + '）';
  }

  var lines = [head];
  if (typeof status.batteryPercentage === 'number') {
    lines.push('電池: ' + status.batteryPercentage + '%');
  }
  if (status.timestamp) {
    // timestamp は秒単位のUNIX時刻
    var d = new Date(Number(status.timestamp) * 1000);
    lines.push('最終更新: ' + Utilities.formatDate(d, 'Asia/Tokyo', 'MM/dd HH:mm'));
  }
  return lines.join('\n');
}

// ===================== 連投抑止 =====================

/**
 * 直近の通知からクールダウン時間内かどうか。
 * @param {Object} cfg
 * @return {boolean}
 */
function isCoolingDown_(cfg) {
  if (!cfg.cooldownMinutes) { return false; }
  var last = PropertiesService.getScriptProperties().getProperty(PROP.LAST_ALERT_AT);
  if (!last) { return false; }
  var elapsedMin = (Date.now() - Number(last)) / 60000;
  return elapsedMin < cfg.cooldownMinutes;
}

/** 通知した時刻を記録する。 */
function markAlerted_() {
  PropertiesService.getScriptProperties()
    .setProperty(PROP.LAST_ALERT_AT, String(Date.now()));
}

/** クールダウン記録をリセットする（テスト用）。 */
function resetCooldown() {
  PropertiesService.getScriptProperties().deleteProperty(PROP.LAST_ALERT_AT);
  console.log('クールダウン記録をリセットしました。');
}

// ===================== LINE 通知 =====================

/**
 * 設定に応じた経路でLINEへ送信する。
 * @param {string} message
 * @param {Object} cfg
 */
function notify_(message, cfg) {
  if (cfg.notifier === 'notify') {
    sendViaLineNotify_(message, cfg);
  } else {
    sendViaMessagingApi_(message, cfg);
  }
}

/**
 * LINE Messaging API のプッシュメッセージで送信する（推奨経路）。
 * @param {string} message
 * @param {Object} cfg
 */
function sendViaMessagingApi_(message, cfg) {
  var payload = {
    to: cfg.lineTo,
    messages: [{ type: 'text', text: message }]
  };
  var res = UrlFetchApp.fetch(LINE_PUSH_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.channelToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('LINE Messaging API 送信失敗 HTTP ' + code + ': ' + truncate_(res.getContentText(), 300));
  }
  console.log('LINE(Messaging API)へ送信しました。');
}

/**
 * LINE Notify で送信する。
 *
 * ※ LINE Notify は 2025年3月31日をもってサービス終了しました。
 *   既存トークンも無効化されているため、この経路は現在動作しません。
 *   互換・参考のため実装を残しています。新規は Messaging API を使ってください。
 *
 * @param {string} message
 * @param {Object} cfg
 */
function sendViaLineNotify_(message, cfg) {
  var res = UrlFetchApp.fetch(LINE_NOTIFY_ENDPOINT, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + cfg.notifyToken },
    payload: { message: message },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('LINE Notify 送信失敗 HTTP ' + code + ': ' + truncate_(res.getContentText(), 300) +
                    ' ／ LINE Notify は2025-03-31に終了しています。NOTIFIER を messaging に変更してください。');
  }
  console.log('LINE(Notify)へ送信しました。');
}

// ===================== トリガー管理 =====================

/**
 * 毎日23時台に checkSesameLock を実行するトリガーを作成する。
 * 既存の同名トリガーは作り直す（重複防止）。
 */
function createDailyTrigger() {
  deleteAllTriggers();
  ScriptApp.newTrigger('checkSesameLock')
    .timeBased()
    .everyDays(1)
    .atHour(23)      // 23:00〜23:59 の間に実行される（GASの仕様上、分単位の指定は不可）
    .nearMinute(0)
    .create();
  console.log('毎日23時のトリガーを作成しました。');
}

/**
 * 30分おきに監視したい場合はこちら（クールダウンで連投は抑止される）。
 */
function createEveryThirtyMinutesTrigger() {
  deleteAllTriggers();
  ScriptApp.newTrigger('checkSesameLock')
    .timeBased()
    .everyMinutes(30)
    .create();
  console.log('30分おきのトリガーを作成しました。');
}

/** このスクリプトのトリガーをすべて削除する。 */
function deleteAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'checkSesameLock') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  console.log('既存トリガーを削除しました（' + triggers.length + '件確認）。');
}

// ===================== 動作確認用 =====================

/** APIから状態が取れるかだけを確認する（通知しない）。 */
function testFetchStatus() {
  var cfg = loadConfig_();
  var status = fetchSesameStatus_(cfg);
  var result = interpretLockState_(status);
  console.log('レスポンス: ' + JSON.stringify(status));
  console.log('判定結果: ' + result.state);
  return result.state;
}

/** LINEへ実際にテスト送信する。 */
function testNotify() {
  var cfg = loadConfig_();
  notify_('✅テスト送信：セサミ閉め忘れ監視の設定が完了しました。', cfg);
}

/**
 * スクリプトプロパティ設定のガイド（実行すると現在値の有無を表示する）。
 * 値そのものはログに出しません。
 */
function showPropertyStatus() {
  var p = PropertiesService.getScriptProperties();
  var keys = [
    PROP.SESAME_API_KEY, PROP.SESAME_DEVICE_UUID, PROP.DEVICE_LABEL, PROP.NOTIFIER,
    PROP.LINE_CHANNEL_ACCESS_TOKEN, PROP.LINE_TO, PROP.LINE_NOTIFY_TOKEN,
    PROP.TREAT_MOVED_AS_UNLOCKED, PROP.NOTIFY_ON_UNKNOWN, PROP.ALERT_COOLDOWN_MINUTES
  ];
  keys.forEach(function (k) {
    var v = p.getProperty(k);
    console.log(k + ': ' + (v ? '設定済み' : '(未設定)'));
  });
}

// ===================== ユーティリティ =====================

/** 'true'/'1'/'yes' を真とみなす。 */
function isTrue_(v) {
  return ['true', '1', 'yes', 'on'].indexOf(String(v).trim().toLowerCase()) >= 0;
}

/** ログ用に文字列を切り詰める。 */
function truncate_(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
