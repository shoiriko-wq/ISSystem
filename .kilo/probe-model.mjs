/** モデルの addComment / getComments を本番 DB に直接当てる（server 起動中に concurrent に読む） */
import bulletinModel from '../src/models/bulletin.model.js';

const items = await bulletinModel.getBulletins({ date: '2026-11-06' });
const target = items.find((p) => String(p.title || '').includes('UI検証削除用掲示')) || items[0];
console.log('target', target && target.id, target && target.title);

const added = await bulletinModel.addComment({
  bulletin_id: target.id,
  author_id: 'T2026001',
  author_name: '教務 主任',
  comment_text: 'モデル直接probe',
});
console.log('added', added && added.id);

const list = await bulletinModel.getComments(target.id);
console.log('getComments', list.map((x) => x.id + ':' + String(x.comment_text).slice(0, 14)));
