# The product server, with the environment it needs (task-77).
#
# RULES_TRACES=1 keeps the reader's signal. The design is in src/rules-traces.mjs:
# no IP, no user agent, no cookie, no account, no session id; 8 random bytes per
# question, tied to nothing; a finding is stored as a pointer to the record, never
# as its prose; the compiled answer is the one corpus-derived thing kept because
# the eval bank grades with it. The page's retention line is what makes keeping a
# question legitimate, and it is rendered in both languages on /rules.
#
# Nothing on disk recorded this before, which is exactly why the running server
# answered saved:false and the reader's feedback was discarded. Every restart now
# goes through this file:  ./start.ps1   (extra flags pass through, e.g. --port).
$env:RULES_TRACES = '1'
node src/server.mjs $args
