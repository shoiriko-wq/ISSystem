import bulletinModel from '../src/models/bulletin.model.js';
import { closeDatabase } from '../config/database.js';

const { addComment, getComments } = bulletinModel;

const postId = 'post_1';
const created = await addComment({
  id: 'cmt_test1',
  bulletin_id: postId,
  author_id: 'kyomu01',
  author_name: '教務 主任',
  comment_text: 'モデル直接呼び出しテスト',
  created_at: new Date().toISOString(),
});
console.log('created=', JSON.stringify(created));

const viaPostId = await addComment({
  id: 'cmt_test2',
  post_id: postId,
  author_id: 'kyomu01',
  author_name: '教務 主任',
  comment_text: 'post_id 版テスト',
});
console.log('viaPostId=', JSON.stringify(viaPostId));

const list = await getComments(postId);
console.log('comments=', JSON.stringify(list.map((c) => [c.id, c.comment_text, c.commenter, c.created_at])));

await closeDatabase();
