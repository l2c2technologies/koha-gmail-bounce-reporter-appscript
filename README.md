# Koha Gmail bounce reporter

A Google Apps Script that watches the mailbox used to send Koha ILS notices,
traps the delivery failure reports that Gmail returns, extracts the reason for
each failure, and mails a digest to one or more designated addresses.

Copyright (C) 2026 L2C2 Technologies.  
Author: Indranil Das Gupta [indradg@l2c2.co.in](mailto:indradg@l2c2.co.in).  
Licensed under the GNU Affero General Public License, version 3 or later.  
Version 1.0

---

## 1. Purpose

Koha sends patron notices through an SMTP relay. When that relay is Google
Workspace, the relay accepts the message synchronously and Koha marks the
corresponding `message_queue` row as `sent`. Any rejection happens later, at
the receiving mail server, and is reported asynchronously by a Delivery Status
Notification (DSN) mailed back to the envelope sender.

Koha never sees that DSN. It has no DSN parser and no bounce handling of any
kind. The practical consequence is that Koha's own view of delivery health is
inaccurate: every notice reads as delivered, including the ones that were
rejected outright.

This script closes that visibility gap. It polls the sending mailbox, parses
the machine readable portion of each DSN, classifies the failure, and reports
it by email to whoever needs to know.

### Scope

The script reports. It does not act.

It does not connect to Koha, does not read or write the Koha database, does not
modify patron records, and does not alter messaging preferences. What happens
after the digest arrives is a matter for library staff and is deliberately
outside the script's remit.

### What a digest contains

For each failed recipient:

* the address that failed
* the RFC 3463 status code
* the diagnostic text returned by the receiving server
* the subject of the original Koha notice
* a direct link to the DSN in Gmail

Failures are grouped into three classes:

| Class | Status | Meaning |
|---|---|---|
| `HARD` | 5.x.x | Permanent. The mailbox does not exist or refuses mail outright. |
| `SOFT` | 4.x.x | Transient. Typically a full mailbox or a temporarily unavailable server. |
| `UNKNOWN` | none parsed | A malformed or non standard bounce. Surfaced rather than discarded. |

---

## 2. How it works

1. A time driven trigger fires on a schedule, hourly by default.
2. The script reads its settings from a `config` tab in a Google Sheet.
3. It takes a script lock so that a manual run and a scheduled run cannot
   overlap.
4. It searches the mailbox for bounce messages within a time window,
   excluding threads it has already reported.
5. For each bounce it reads the raw MIME source and splits it on
   `Final-Recipient` boundaries, yielding one record per failed address. A
   single DSN can carry several.
6. Each record is classified from its status code, appended to a register tab,
   and included in the digest.
7. The digest is mailed. Only after that succeeds are the threads labelled as
   processed.

Step 7 is the error strategy. If the digest fails to send, nothing is labelled
and the next run retries the same threads.

Two independent de-duplication layers prevent repeat reporting. The Gmail
label is the coarse layer, excluding whole threads already handled. The
register is the fine layer: the Gmail message ID of every reported DSN is
recorded, which catches the case where a second DSN lands on a thread that was
labelled earlier. That second case is real, because a soft failure produces a
delay warning first and a final failure some days later, both on the same
thread.

---

## 3. Prerequisites

* A Google Workspace account that receives the DSNs.
* Permission to create Apps Script projects and Google Sheets under that
  account.
* At least one destination address for the digest.

---

## 4. Installation

### Step 1: create the script project

Sign in as the account that receives the bounces. Go to
`https://script.google.com` and create a new project. Give it a recognisable
name.

### Step 2: add the code

Open `Code.gs` in the editor, delete the placeholder content, and paste in the
full contents of `koha-bounce-reporter.gs`. Save.

### Step 3: create the config spreadsheet

From the function dropdown at the top of the editor, select
`bootstrapConfigSheet` and run it.

The first run prompts for authorisation. Review the scopes and accept. The
script requests access to Gmail, Sheets, and the ability to send mail as the
signed in account.

On completion the execution log prints the URL of a new spreadsheet named
`Koha bounce reporter`. It contains two tabs, `config` and `bounces`. The
spreadsheet ID is stored in the project's script properties under the key
`CONFIG_SPREADSHEET_ID`, so the script will find it on every later run.

To use an existing spreadsheet instead, paste its ID into
`BOOTSTRAP.SPREADSHEET_ID` near the top of the code before running
`bootstrapConfigSheet`.

### Step 4: set the destination addresses

Open the spreadsheet, go to the `config` tab, and put at least one address in
the `value` cell of the `notify` row. Several addresses are separated by
commas.

This is the only setting with no working default. A run with `notify` empty
throws rather than sending the digest nowhere.

Review the other settings at this point. Section 5 describes each one.

### Step 5: verify the configuration

Back in the script editor, run `showConfig`. The execution log prints every
setting as the script has resolved it, plus the spreadsheet URL. Confirm the
values are what you intended.

### Step 6: dry run

Run `previewBounces`.

This performs a full search and parse and writes the results to the execution
log. It sends no mail, writes no register rows, and applies no labels. Use it
to confirm that bounces are being found and that the addresses and diagnostics
are being extracted correctly.

If the log shows no threads matched and you know bounces are present, see
section 7.

### Step 7: schedule it

Run `installTrigger`. This removes any existing trigger for the job and creates
a fresh hourly one, pinned near the top of the hour.

Apps Script does not guarantee an exact minute. `nearMinute(0)` places the run
within roughly fifteen minutes either side of the hour boundary, which is as
tight as the platform allows.

Confirm under the clock icon in the left sidebar of the editor that the trigger
exists. The first digest will arrive at the next hour boundary if there are
unreported bounces.

To change the interval, edit the `everyHours(1)` call in `installTrigger` and
run it again. Keep the `window` setting comfortably wider than the interval.

### Step 8: check the first live run

After the first scheduled execution, confirm three things: the digest arrived,
the register tab has rows, and the processed label appears on the bounce
threads in the mailbox.

---

## 5. Configuration reference

All settings live in the `config` tab. Column A is the key, column B the value,
column C a note for whoever is editing. Only A and B are read.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | boolean | `TRUE` | Master switch. `FALSE` stops the job without deleting the trigger. |
| `notify` | list | none | Digest recipients, comma separated. Required. |
| `notify_cc` | list | empty | Optional CC addresses. |
| `search_query` | string | Gmail mailer-daemon matcher | Gmail search that identifies bounce messages. |
| `window` | string | `newer_than:2d` | How far back each poll looks. |
| `subject_filter` | string | empty | Report only bounces whose original notice subject matches. Plain text is a substring test; slash delimiters make it a regular expression. Empty means all. See below. |
| `max_threads` | integer | `200` | Ceiling per run. Clamped to 500, the Gmail search limit. |
| `processed_label` | string | `Koha/Bounces/Processed` | Label applied to reported threads. |
| `send_when_empty` | boolean | `FALSE` | Send a "nothing to report" mail on quiet runs. |
| `attach_csv` | boolean | `TRUE` | Attach a CSV of the run to the digest. |
| `register_enabled` | boolean | `TRUE` | Append parsed bounces to the register. Also enables message ID de-duplication. |
| `register_sheet_name` | string | `bounces` | Tab name for the register. |
| `digest_subject` | string | `[Koha] Bounce report` | Subject prefix for the digest. |
| `timezone` | string | `Asia/Kolkata` | Timezone for timestamps in the digest and CSV. |

Behaviour notes:

* Settings are read fresh at the start of every run, so edits take effect on
  the next poll with no redeploy.
* Keys are matched case insensitively and whitespace is trimmed. Rows are
  order independent. Unrecognised keys are ignored, so you may add your own
  annotation rows.
* A blank value cell falls back to the coded default. So does a missing row.
  Blanking a cell resets a setting; it does not disable it.
* `subject_filter` is the one setting whose coded default is empty, so a blank
  cell there genuinely means no filter.
* Booleans accept `TRUE`, `FALSE`, `yes`, `no`, `1`, `0`, `on`. Lists split on
  comma, semicolon, or newline.
* `bootstrapConfigSheet` is safe to re-run. It appends only keys that are
  absent and never overwrites an existing value.

### 5.1 The `subject_filter` setting

The filter is tested against the subject of the original notice, which is the
first message in the bounce thread. It takes one of three forms.

| Form | Behaviour |
|---|---|
| blank | No filtering. Every bounce is reported. |
| `Overdue` | Case sensitive substring match. |
| `/overdue\|hold available/i` | Regular expression, case insensitive here. |

A value delimited by slashes is compiled as a JavaScript regular expression.
Trailing flags may be any of `i`, `m`, `s`, `u`; anything else is ignored. The
`g` flag is stripped deliberately, because a global expression retains state
between tests and would match only every other thread.

The expression is compiled once when the configuration is read, so a syntax
error is reported at the start of the run rather than partway through.

Examples:

| Value | Effect |
|---|---|
| `/^Overdue/` | Subjects beginning with `Overdue`. |
| `/overdue\|hold available\|item due/i` | Any of three notice types, any casing. |
| `/^(?!Welcome).*$/` | Everything except welcome notices. |
| `/library$/` | Subjects ending in `library`. |

Note that `|` inside a table cell must be escaped as `\|` in this document but
is written plainly in the sheet.

Two caveats apply to any non blank value.

The subject tested is that of the first message in the thread. If Gmail did
not thread the bounce with the original, for instance because the sent copy
was deleted, the subject seen is the bounce's own `Delivery Status
Notification (Failure)` and the record is silently excluded. A blank filter
avoids this entirely.

A filter narrows what is reported, not what is labelled. Threads that fail the
filter are still marked processed at the end of the run. Removing the filter
later will not bring back the bounces skipped while it was active.

---

## 6. The register tab

Nine columns, header row frozen. The script only appends, and only ever reads
back column I.

| # | Column | Content |
|---|---|---|
| A | `bounce_date` | Date the DSN arrived, in the configured timezone |
| B | `class` | `HARD`, `SOFT`, or `UNKNOWN` |
| C | `status` | RFC 3463 status code from the DSN |
| D | `recipient` | Failed address, lowercased |
| E | `action` | `failed` or `delayed` |
| F | `diagnostic` | Diagnostic text from the receiving server |
| G | `remote_mta` | Receiving server that issued the rejection |
| H | `original_subject` | Subject of the original Koha notice |
| I | `gmail_message_id` | Gmail ID of the DSN. De-duplication key. |

You may sort, filter, format, or add columns to the right without affecting
the script.

Do not clear or delete rows. Column I is what prevents a second DSN on an
already labelled thread from being missed. If the register grows unwieldy,
archive to another tab or file rather than deleting in place.

---

## 7. Operations and troubleshooting

**No threads matched, but bounces are visible in the mailbox.** Check that the
threads do not already carry the processed label from an earlier run. Then
widen `window`. Then check `search_query` against the actual sender of the
bounces in your environment, which may differ if mail is relayed through
something other than Gmail directly.

**Bounces found but no records parsed.** The DSN is non standard and is falling
through to the fallback path, which will report it as `UNKNOWN`. If nothing at
all is produced, capture one raw message via the Gmail "Show original" view for
diagnosis.

**Execution timeouts.** Reading raw MIME is the expensive operation. Apps
Script allows six minutes per execution on consumer accounts and thirty on
Workspace. If runs time out during a bulk patron import, shorten `window` and
raise the trigger frequency rather than raising `max_threads`.

**Suppressing noise during a bulk import.** Set `enabled` to `FALSE`. The
trigger stays in place and the job exits immediately. Threads remain
unlabelled, so nothing is lost; set it back to `TRUE` and the backlog is
reported on the next run, subject to `window` and `max_threads`.

**One duplicate digest after a crash.** If execution dies between sending the
digest and applying labels, the same threads are reported once more on the next
run. This is the intended failure direction.

**Quotas.** The digest is one message per run, well inside any sending quota.
Gmail search is capped at 500 threads per call.

---

## 8. Privacy note

The register contains patron email addresses. Anyone granted edit access to the
config settings also gains access to that data, because both tabs live in the
same spreadsheet. Where the people adjusting settings are not the people
entitled to see patron data, split the register into a separate spreadsheet.

---

## 9. Function reference

| Function | Purpose |
|---|---|
| `bootstrapConfigSheet()` | Creates or completes the config spreadsheet. Run once at install, and again after adding a setting. Idempotent. |
| `showConfig()` | Prints the effective settings and the spreadsheet URL to the execution log. |
| `previewBounces()` | Dry run. Parses and logs, sends nothing, labels nothing. |
| `installTrigger()` | Schedules the job. Removes any existing trigger for it first. |
| `pollBounces()` | The scheduled job. |
| `removeTriggers()` | Uninstalls the schedule. |

---

## 10. Licence

Copyright (C) 2026 L2C2 Technologies.

Author: Indranil Das Gupta [indradg@l2c2.co.in](mailto:indradg@l2c2.co.in).

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
