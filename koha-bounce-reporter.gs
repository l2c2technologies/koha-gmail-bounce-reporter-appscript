/**
 * Koha Gmail bounce reporter for Google Workspace.
 *
 * Copyright (C) 2026 L2C2 Technologies
 * Author: Indranil Das Gupta <indradg@l2c2.co.in>
 * Version: 1.0
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ------------------------------------------------------------------
 *
 * Runs under the mailbox that receives the DSNs. Polls for Mailer-Daemon
 * messages, parses the message/delivery-status parts, and mails a digest
 * to pre-defined addresses. All settings live in a "config" tab of a
 * Google Sheet, so they can be changed without touching this code.
 *
 * The same spreadsheet holds the persistent bounce register.
 *
 * First run:
 *   bootstrapConfigSheet()   creates the spreadsheet, config tab and
 *                            register tab, and remembers the ID
 *   showConfig()             prints the effective settings
 *   previewBounces()         dry run; parses and logs, sends nothing
 *   installTrigger()         schedules pollBounces() hourly
 *
 * Later:
 *   pollBounces()            the scheduled job
 *   removeTriggers()         uninstall
 */

/* ------------------------------------------------------------------ */
/* Bootstrap: the only thing that cannot live in the sheet             */
/* ------------------------------------------------------------------ */

var BOOTSTRAP = {
  // Leave blank and let bootstrapConfigSheet() create the spreadsheet
  // and store the ID in script properties. Or paste an existing ID here.
  SPREADSHEET_ID: '',
  CONFIG_SHEET_NAME: 'config',
  PROPERTY_KEY: 'CONFIG_SPREADSHEET_ID'
};

/**
 * key, type, default, note. The note is written into the sheet so the
 * person editing it does not have to read this file.
 */
var SETTINGS = [
  ['enabled',            'bool',   true,
   'Master switch. FALSE stops the job without deleting the trigger.'],
  ['notify',             'list',   '',
   'Digest recipients. Comma separated. Required.'],
  ['notify_cc',          'list',   '',
   'Optional CC addresses. Comma separated.'],
  ['search_query',       'string',
   'from:mailer-daemon@googlemail.com OR from:mailer-daemon@google.com OR from:postmaster@googlemail.com',
   'Gmail search that identifies bounce messages.'],
  ['window',             'string', 'newer_than:2d',
   'How far back each poll looks. Keep larger than the trigger interval.'],
  ['subject_filter',     'string', '',
   'Only report bounces whose original subject contains this text. Wrap in slashes for a regular expression, for example /overdue|hold available/i. Blank means all.'],
  ['max_threads',        'int',    200,
   'Ceiling per run. Raise during bulk patron imports. Hard limit 500.'],
  ['processed_label',    'string', 'Koha/Bounces/Processed',
   'Threads already reported carry this label and are skipped.'],
  ['send_when_empty',    'bool',   false,
   'TRUE sends a "nothing to report" mail on quiet runs.'],
  ['attach_csv',         'bool',   true,
   'Attach a CSV of the run to the digest.'],
  ['register_enabled',   'bool',   true,
   'Append every parsed bounce to the register tab. Also enables cross-run de-duplication.'],
  ['register_sheet_name','string', 'bounces',
   'Tab name for the register.'],
  ['digest_subject',     'string', '[Koha] Bounce report',
   'Subject prefix for the digest mail.'],
  ['timezone',           'string', 'Asia/Kolkata',
   'Timezone for timestamps in the digest and CSV.']
];

/**
 * The register schema, declared once. The header row, the order of appended
 * values, and the CSV all derive from this list, so they cannot drift apart.
 *
 * Changing this list is a schema change. Existing register tabs keep their
 * old header, because ensureRegisterSheet_ only writes one when creating the
 * tab, so an existing sheet must be migrated to match. verifyRegisterSchema_
 * refuses to write into a mismatched sheet rather than misaligning the data.
 */
var REGISTER_COLUMNS = [
  'bounce_date',
  'class',
  'status',
  'recipient',
  'action',
  'diagnostic',
  'original_subject',
  'gmail_message_id'
];

var REGISTER_KEY_COLUMN = 'gmail_message_id';

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('pollBounces')
    .timeBased()
    .everyHours(1)
    .nearMinute(0)
    .create();
  Logger.log('pollBounces scheduled hourly, near the top of the hour.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollBounces') ScriptApp.deleteTrigger(t);
  });
}

/* ------------------------------------------------------------------ */
/* Config plumbing                                                     */
/* ------------------------------------------------------------------ */

function spreadsheetId_() {
  var stored = PropertiesService.getScriptProperties()
                 .getProperty(BOOTSTRAP.PROPERTY_KEY);
  var id = stored || BOOTSTRAP.SPREADSHEET_ID;
  if (!id) {
    throw new Error('No config spreadsheet. Run bootstrapConfigSheet() once, ' +
                    'or paste an existing ID into BOOTSTRAP.SPREADSHEET_ID.');
  }
  return id;
}

function loadConfig_() {
  var ss = SpreadsheetApp.openById(spreadsheetId_());
  var sheet = ss.getSheetByName(BOOTSTRAP.CONFIG_SHEET_NAME);
  if (!sheet) {
    throw new Error('Tab "' + BOOTSTRAP.CONFIG_SHEET_NAME + '" not found in ' +
                    ss.getName() + '. Run bootstrapConfigSheet().');
  }

  var raw = {};
  var last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
      var k = String(row[0] || '').trim().toLowerCase();
      if (k) raw[k] = row[1];
    });
  }

  var cfg = { _spreadsheet: ss };
  SETTINGS.forEach(function (s) {
    cfg[s[0]] = coerce_(raw[s[0]], s[1], s[2]);
  });

  if (!cfg.notify.length) {
    throw new Error('Setting "notify" is empty in the config tab. ' +
                    'Nothing would receive the digest.');
  }
  if (cfg.max_threads > 500) cfg.max_threads = 500;

  cfg._subjectTest = buildSubjectTest_(cfg.subject_filter);

  return cfg;
}

/**
 * Builds the subject predicate from the configured filter.
 *
 * Blank            match everything
 * plain text       case sensitive substring match
 * /pattern/flags   regular expression; flags may be any of i, m, s, u
 *
 * The g flag is stripped deliberately: a global RegExp keeps state in
 * lastIndex between calls to test(), which would make the filter match
 * every other thread.
 */
function buildSubjectTest_(spec) {
  if (!spec) {
    return function () { return true; };
  }

  var m = String(spec).match(/^\/(.*)\/([a-zA-Z]*)$/);
  if (m && m[1] !== '') {
    var flags = m[2].replace(/[^imsu]/g, '');
    var re;
    try {
      re = new RegExp(m[1], flags);
    } catch (e) {
      throw new Error('Setting "subject_filter" is not a valid regular ' +
                      'expression: ' + e.message);
    }
    return function (s) { return re.test(String(s || '')); };
  }

  return function (s) { return String(s || '').indexOf(spec) !== -1; };
}

function coerce_(value, type, fallback) {
  var blank = (value === undefined || value === null ||
               String(value).trim() === '');

  switch (type) {
    case 'bool':
      if (blank) return fallback;
      if (typeof value === 'boolean') return value;
      return /^(true|yes|y|1|on)$/i.test(String(value).trim());

    case 'int':
      if (blank) return fallback;
      var n = parseInt(String(value).trim(), 10);
      return isNaN(n) ? fallback : n;

    case 'list':
      if (blank) return (String(fallback).trim() === '') ? [] : [String(fallback)];
      return String(value)
        .split(/[,;\n]/)
        .map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length > 0; });

    default: // string
      return blank ? String(fallback) : String(value).trim();
  }
}

function showConfig() {
  var cfg = loadConfig_();
  SETTINGS.forEach(function (s) {
    var v = cfg[s[0]];
    Logger.log(s[0] + ' = ' + (Array.isArray(v) ? '[' + v.join(', ') + ']' : v));
  });
  Logger.log('spreadsheet: ' + cfg._spreadsheet.getUrl());
}

/**
 * Creates the spreadsheet (or fills in an existing one), writes the
 * config tab with defaults and inline notes, and creates the register.
 * Safe to re-run: existing values are left alone, missing keys are added.
 */
function bootstrapConfigSheet() {
  var stored = PropertiesService.getScriptProperties()
                 .getProperty(BOOTSTRAP.PROPERTY_KEY) || BOOTSTRAP.SPREADSHEET_ID;

  var ss;
  if (stored) {
    ss = SpreadsheetApp.openById(stored);
  } else {
    ss = SpreadsheetApp.create('Koha Gmail bounce reporter');
    PropertiesService.getScriptProperties()
      .setProperty(BOOTSTRAP.PROPERTY_KEY, ss.getId());
    var first = ss.getSheets()[0];
    if (first.getName() === 'Sheet1') first.setName(BOOTSTRAP.CONFIG_SHEET_NAME);
  }

  var sheet = ss.getSheetByName(BOOTSTRAP.CONFIG_SHEET_NAME) ||
              ss.insertSheet(BOOTSTRAP.CONFIG_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['key', 'value', 'notes']);
  }

  var existing = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach(function (r) {
        var k = String(r[0] || '').trim().toLowerCase();
        if (k) existing[k] = true;
      });
  }

  var toAdd = SETTINGS
    .filter(function (s) { return !existing[s[0]]; })
    .map(function (s) {
      var d = Array.isArray(s[2]) ? s[2].join(', ') : s[2];
      return [s[0], d, s[3]];
    });

  if (toAdd.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(3, 520);
  sheet.getRange(1, 3, sheet.getLastRow(), 1).setWrap(true);

  ensureRegisterSheet_(ss, 'bounces');

  Logger.log('Config spreadsheet ready: ' + ss.getUrl());
  Logger.log('Set "notify" in the config tab before the first live run.');
  return ss.getUrl();
}

function ensureRegisterSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(REGISTER_COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, REGISTER_COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Reads the header row of an existing register and returns a map of column
 * name to 1-based index.
 */
function registerHeaderMap_(sheet) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var header = sheet.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  header.forEach(function (name, i) {
    var key = String(name || '').trim().toLowerCase();
    if (key) map[key] = i + 1;
  });
  return map;
}

/**
 * Refuses to append to a register whose header does not match the current
 * schema. Writing positionally into a mismatched sheet would misalign every
 * column and, worse, would break de-duplication silently.
 */
function verifyRegisterSchema_(sheet) {
  if (sheet.getLastRow() === 0) return;

  var header = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
                    .getValues()[0]
                    .map(function (v) { return String(v || '').trim().toLowerCase(); })
                    .filter(function (v) { return v !== ''; });

  var matches = header.length === REGISTER_COLUMNS.length &&
                REGISTER_COLUMNS.every(function (name, i) {
                  return header[i] === name;
                });

  if (!matches) {
    throw new Error(
      'Register tab "' + sheet.getName() + '" does not match the current ' +
      'schema. Expected: ' + REGISTER_COLUMNS.join(', ') + '. Found: ' +
      header.join(', ') + '. Run migrateRegister() to bring it into line, ' +
      'or point register_sheet_name at a new tab.');
  }
}

/**
 * Brings an existing register tab into line with REGISTER_COLUMNS by deleting
 * columns the schema no longer declares. Run manually, once, after a schema
 * change. Safe to re-run: it exits quietly when the header already matches.
 *
 * Columns are only ever deleted, never reordered or inserted, so anything
 * beyond that needs doing by hand.
 */
function migrateRegister() {
  var cfg = loadConfig_();
  var sheet = cfg._spreadsheet.getSheetByName(cfg.register_sheet_name);

  if (!sheet) {
    Logger.log('No register tab named "' + cfg.register_sheet_name + '". ' +
               'Nothing to migrate.');
    return;
  }

  var map = registerHeaderMap_(sheet);
  var obsolete = Object.keys(map).filter(function (name) {
    return REGISTER_COLUMNS.indexOf(name) === -1;
  });

  if (!obsolete.length) {
    Logger.log('Register already matches the current schema. No change made.');
    verifyRegisterSchema_(sheet);
    return;
  }

  // Delete right to left so earlier indices stay valid.
  obsolete
    .map(function (name) { return { name: name, index: map[name] }; })
    .sort(function (a, b) { return b.index - a.index; })
    .forEach(function (col) {
      sheet.deleteColumn(col.index);
      Logger.log('Deleted column ' + col.index + ' (' + col.name + ').');
    });

  verifyRegisterSchema_(sheet);
  Logger.log('Register migrated. Header is now: ' + REGISTER_COLUMNS.join(', '));
}

/* ------------------------------------------------------------------ */
/* Main job                                                            */
/* ------------------------------------------------------------------ */

function pollBounces() { run_(false); }
function previewBounces() { run_(true); }

function run_(dryRun) {
  var cfg = loadConfig_();

  if (!cfg.enabled) {
    Logger.log('Disabled via config tab; exiting.');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('Another run holds the lock; exiting.');
    return;
  }

  try {
    var label = getOrCreateLabel_(cfg.processed_label);
    var query = '(' + cfg.search_query + ') ' + cfg.window +
                ' -label:"' + cfg.processed_label + '"';

    var threads = GmailApp.search(query, 0, cfg.max_threads);
    Logger.log('Query: ' + query);
    Logger.log('Threads matched: ' + threads.length);

    var seen = loadSeenIds_(cfg);
    var records = [];
    var touched = [];

    threads.forEach(function (thread) {
      var messages = thread.getMessages();
      var original = messages[0];
      var originalSubject = original ? original.getSubject() : '';

      if (!cfg._subjectTest(originalSubject)) {
        return;
      }

      messages.forEach(function (msg) {
        if (!isDsn_(msg)) return;
        if (seen[msg.getId()]) return;
        parseDsn_(msg, originalSubject).forEach(function (r) {
          records.push(r);
        });
        seen[msg.getId()] = true;
      });

      touched.push(thread);
    });

    Logger.log('Bounce records parsed: ' + records.length);

    if (dryRun) {
      records.forEach(function (r) {
        Logger.log([r['class'], r.status, r.recipient, r.diagnostic].join(' | '));
      });
      Logger.log('Dry run; no mail sent, no labels applied.');
      return;
    }

    if (records.length > 0) {
      if (cfg.register_enabled) appendToRegister_(cfg, records);
      sendDigest_(cfg, records);
    } else if (cfg.send_when_empty) {
      sendEmptyDigest_(cfg);
    }

    touched.forEach(function (t) { t.addLabel(label); });

  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Detection and parsing                                               */
/* ------------------------------------------------------------------ */

function isDsn_(msg) {
  var from = (msg.getFrom() || '').toLowerCase();
  if (from.indexOf('mailer-daemon') !== -1) return true;
  if (from.indexOf('postmaster@') !== -1) return true;
  var subj = (msg.getSubject() || '').toLowerCase();
  return subj.indexOf('delivery status notification') !== -1 ||
         subj.indexOf('undeliverable') !== -1;
}

/**
 * Splits the raw MIME on Final-Recipient boundaries and returns one
 * record per failed recipient. A single DSN can carry several.
 */
function parseDsn_(msg, originalSubject) {
  var raw = '';
  try {
    raw = msg.getRawContent();
  } catch (e) {
    Logger.log('Could not read raw content for ' + msg.getId() + ': ' + e);
    return [];
  }

  var out = [];
  var chunks = raw.split(/^Final-Recipient:/m);
  chunks.shift();

  chunks.forEach(function (tail) {
    // A DSN record is short; capping avoids running into the quoted
    // original message that follows the last record.
    var chunk = 'Final-Recipient:' + tail.substring(0, 2000);

    var recipient = cleanAddress_(field_(chunk, 'Final-Recipient'));
    if (!recipient) return;

    var action = field_(chunk, 'Action');
    if (action &&
        action.toLowerCase().indexOf('fail') === -1 &&
        action.toLowerCase().indexOf('delayed') === -1) {
      return; // relayed or expanded, not a failure
    }

    var status = field_(chunk, 'Status');
    var diagnostic = collapse_(field_(chunk, 'Diagnostic-Code'));

    out.push({
      when: msg.getDate(),
      recipient: recipient,
      status: status,
      'class': classify_(status, diagnostic),
      action: action,
      diagnostic: diagnostic,
      originalSubject: originalSubject || '',
      messageId: msg.getId(),
      permalink: 'https://mail.google.com/mail/u/0/#all/' + msg.getId()
    });
  });

  // Fallback for human-readable bounces with no delivery-status part.
  if (out.length === 0) {
    var guess = raw.match(/(?:wasn't delivered to|couldn't be delivered to)\s+(\S+@\S+?)[\s,.]/i);
    if (guess) {
      out.push({
        when: msg.getDate(),
        recipient: cleanAddress_(guess[1]),
        status: '',
        'class': 'UNKNOWN',
        action: '',
        diagnostic: collapse_(msg.getPlainBody().substring(0, 300)),
        originalSubject: originalSubject || '',
        messageId: msg.getId(),
        permalink: 'https://mail.google.com/mail/u/0/#all/' + msg.getId()
      });
    }
  }

  return out;
}

function field_(text, name) {
  var re = new RegExp('^' + name + ':[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)', 'mi');
  var m = text.match(re);
  return m ? m[1].trim() : '';
}

function cleanAddress_(v) {
  if (!v) return '';
  return v.replace(/^rfc822\s*;\s*/i, '').replace(/[<>]/g, '').trim().toLowerCase();
}

function collapse_(v) {
  return (v || '').replace(/\s+/g, ' ').replace(/^smtp;\s*/i, '').trim();
}

/**
 * HARD  5.x.x  address does not exist; clear it in Koha
 * SOFT  4.x.x  transient, for example a full mailbox; retry then suppress
 */
function classify_(status, diagnostic) {
  if (/^5\./.test(status)) return 'HARD';
  if (/^4\./.test(status)) return 'SOFT';
  if (/\b5\d\d[\s-]/.test(diagnostic)) return 'HARD';
  if (/\b4\d\d[\s-]/.test(diagnostic)) return 'SOFT';
  return 'UNKNOWN';
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function sendDigest_(cfg, records) {
  var hard  = records.filter(function (r) { return r['class'] === 'HARD'; });
  var soft  = records.filter(function (r) { return r['class'] === 'SOFT'; });
  var other = records.filter(function (r) { return r['class'] === 'UNKNOWN'; });

  var stamp = Utilities.formatDate(new Date(), cfg.timezone, 'yyyy-MM-dd HH:mm');
  var subject = cfg.digest_subject + ': ' + records.length +
                ' (' + hard.length + ' hard, ' + soft.length + ' soft) ' + stamp;

  var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px">';
  html += '<p>Mailbox: <b>' + Session.getActiveUser().getEmail() + '</b><br>';
  html += 'Window: ' + cfg.window + ' &middot; Generated: ' + stamp + '</p>';
  html += section_('Hard failures (clear the address in Koha)', hard);
  html += section_('Soft failures (transient; retry, suppress if repeated)', soft);
  html += section_('Unclassified', other);
  if (cfg.register_enabled) {
    html += '<p><a href="' + cfg._spreadsheet.getUrl() + '">Open the bounce register</a></p>';
  }
  html += '<p style="color:#666">Reported threads are labelled "' +
          cfg.processed_label + '" and will not be sent again.</p></div>';

  var options = { htmlBody: html, name: 'Koha Gmail bounce reporter' };
  if (cfg.notify_cc.length) options.cc = cfg.notify_cc.join(',');
  if (cfg.attach_csv) {
    options.attachments = [Utilities.newBlob(
      toCsv_(cfg, records), 'text/csv',
      'koha-bounces-' +
      Utilities.formatDate(new Date(), cfg.timezone, 'yyyyMMdd-HHmm') + '.csv'
    )];
  }

  GmailApp.sendEmail(cfg.notify.join(','), subject, plainFallback_(records), options);
}

function section_(title, rows) {
  if (!rows.length) return '';
  var h = '<h3 style="margin:18px 0 6px">' + title + ' (' + rows.length + ')</h3>';
  h += '<table cellpadding="6" cellspacing="0" border="1" ' +
       'style="border-collapse:collapse;font-size:12px;border-color:#ccc">';
  h += '<tr style="background:#f2f2f2"><th align="left">Address</th>' +
       '<th align="left">Status</th><th align="left">Original subject</th>' +
       '<th align="left">Diagnostic</th><th align="left">Open</th></tr>';
  rows.forEach(function (r) {
    h += '<tr><td>' + esc_(r.recipient) + '</td>' +
         '<td>' + esc_(r.status) + '</td>' +
         '<td>' + esc_(r.originalSubject) + '</td>' +
         '<td>' + esc_(truncate_(r.diagnostic, 160)) + '</td>' +
         '<td><a href="' + r.permalink + '">view</a></td></tr>';
  });
  return h + '</table>';
}

function plainFallback_(records) {
  return records.map(function (r) {
    return [r['class'], r.status, r.recipient, truncate_(r.diagnostic, 120)].join(' | ');
  }).join('\n');
}

function sendEmptyDigest_(cfg) {
  GmailApp.sendEmail(cfg.notify.join(','),
    cfg.digest_subject + ': no new bounces',
    'No new delivery failures in the last poll window (' + cfg.window + ').');
}

function toCsv_(cfg, records) {
  var lines = [REGISTER_COLUMNS.join(',')];
  records.forEach(function (r) {
    lines.push(registerRow_(cfg, r).map(csvCell_).join(','));
  });
  return lines.join('\n');
}

/**
 * Builds one row in REGISTER_COLUMNS order. Used by both the register and
 * the CSV, so the two can never disagree.
 */
function registerRow_(cfg, r) {
  return [
    Utilities.formatDate(r.when, cfg.timezone, 'yyyy-MM-dd HH:mm:ss'),
    r['class'],
    r.status,
    r.recipient,
    r.action,
    r.diagnostic,
    r.originalSubject,
    r.messageId
  ];
}

function csvCell_(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

/* ------------------------------------------------------------------ */
/* Register and de-duplication                                         */
/* ------------------------------------------------------------------ */

function appendToRegister_(cfg, records) {
  var sheet = ensureRegisterSheet_(cfg._spreadsheet, cfg.register_sheet_name);
  verifyRegisterSchema_(sheet);

  var rows = records.map(function (r) { return registerRow_(cfg, r); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
       .setValues(rows);
}

/**
 * Guards against re-reporting when a second DSN lands on an already
 * labelled thread, for example a delay warning followed days later by
 * the final failure.
 */
function loadSeenIds_(cfg) {
  var seen = {};
  if (!cfg.register_enabled) return seen;

  var sheet = cfg._spreadsheet.getSheetByName(cfg.register_sheet_name);
  if (!sheet) return seen;

  var last = sheet.getLastRow();
  if (last < 2) return seen;

  // Located by header name, not by position, so a schema change cannot
  // silently point this at the wrong column.
  var column = registerHeaderMap_(sheet)[REGISTER_KEY_COLUMN];
  if (!column) {
    throw new Error('Register tab "' + sheet.getName() + '" has no "' +
                    REGISTER_KEY_COLUMN + '" column. De-duplication cannot ' +
                    'run. Check the header row.');
  }

  var start = Math.max(2, last - 4999);
  sheet.getRange(start, column, last - start + 1, 1).getValues()
    .forEach(function (row) { if (row[0]) seen[row[0]] = true; });
  return seen;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function esc_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.substring(0, n) + '...' : s;
}
