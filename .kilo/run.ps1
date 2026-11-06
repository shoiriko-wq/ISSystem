Set-Location 'c:\Users\入江田　承\Documents\プログラミング\ISSystem'
$env:NODE_EXTRA_CA_CERTS = Join-Path (Get-Location) 'certs\issystem-ca.crt'
node scripts/test-bulletin-split.mjs 2>&1 | Select-String -Pattern 'comment-post =|comment-send-e2e|FAIL ' | Select-Object -First 4
