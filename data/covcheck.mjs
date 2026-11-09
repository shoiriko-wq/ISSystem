import fs from 'node:fs';

const sjis = new TextDecoder('shift_jis');
const read = (p) => {
  const buf = fs.readFileSync(p);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return sjis.decode(buf);
  }
};
const words = ['メールボックス', '発言者', 'general チャット', '追加の権限', '縦移動', '初回クリック', 'UI十条', 'スクリーンショット', '67.25px', '16.3rem', 'NODE_EXTRA_CA_CERTS', '斜め移動'];
for (const f of ['README.md', 'AGENTS.md', 'ISSystem仕様書.md']) {
  const t = read(f);
  console.log('== ' + f);
  words.forEach((w) => console.log(f, w, t.includes(w)));
}
