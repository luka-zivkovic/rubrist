# Loading, errors, and waits closeout

Status: **CURRENT implementation**, 2026-09-28. Covers S6, the remaining C6/C7
loading and wait feedback, and S4's unavailable project label. Existing product
vocabulary and display modes remain unchanged.

An API 401 now reaches sign-in at the existing browser URL, including case or
version path and query selection. Successful sign-in reloads that location.
A background dashboard refresh also surfaces session expiry instead of keeping
stale signed-in data. Other transient background failures preserve last-known
data; explicit reload offers recovery and retains the actual HTTP status.

The shell waits for criterion discovery, then lets each page own its loading
and error states. A missing dashboard no longer masks the review queue's Retry
or presents it as clear. Independent pages stay accessible with a compact
project-summary error. A missing project name reads as loading or unavailable,
not the Rubrist product name presented as a project.

A server error says that the server returned an error and includes its real
HTTP status. An unknown transport failure invents neither an HTTP status nor
an internet-disconnection diagnosis. Retry is offered for transient failures,
not refused requests that would repeat unchanged. Queue and overview errors
no longer instruct users to start a development API.

Evaluator, editor, version history, comparison, overview and queue loading
views use visible placeholders shaped for their content. The skeleton has one
accessible busy status; decorative placeholders hide from screen readers and
animate only when reduced motion is not requested. No placeholder supplies a
zero count or successful outcome.

Pending regression results show elapsed time since the immutable version was
saved. That timestamp is deliberately not presented as provider execution
start. After two minutes the message explains that the worker may be queued or
processing and that it is safe to leave and return through Version history.
A delayed result remains pending. A stopped status read stops the elapsed timer
and does not claim to keep checking. Version-history rows show the same wait
feedback only while their regression result is absent; recorded governed
candidates do not inherit a false running timer.

Verification includes rendered API401/sign-in with preserved URL, reachable
queue error/retry, actual 500 and unknown transport errors, refused-read retry
suppression, accessible loading placeholders, elapsed/long-wait timers and
cleanup, dashboard retry/401/background-refresh behavior, plus the existing
regression polling and missing-evidence tests. No provider calls or stored
human judgments are made by these tests.

This slice does not impose an execution timeout or cancel a saved check.
A slow worker can still finish later; the UI does not infer failure from age.
