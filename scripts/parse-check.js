/** 構文チェック用（ESM パースのみ検証し実行はしない） */
import vm from 'node:vm';
import fs from 'node:fs';

const files = process.argv.slice(2);
let fail = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { filename: f });
    console.log('PARSE_OK ' + f);
  } catch (e) {
    fail += 1;
    console.log('PARSE_FAIL ' + f + ' :: ' + e.message);
  }
}
process.exit(fail ? 1 : 0);
