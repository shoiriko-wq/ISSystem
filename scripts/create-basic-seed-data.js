/**
 * ISSystem 基本情報マスタ 初期データ CSV 生成スクリプト (scripts/create-basic-seed-data.js)
 *
 * data/seed/*.csv を現実的な学校データとして書き出す (ISSystem仕様書 §19・README 基本情報マスタ)。
 *  - 教職員 62名（システム管理者・教務主任・教員60名）→ users.csv
 *    テストが参照する 田中/佐藤/鈴木/高橋 (t-tanaka/t-sato/t-suzuki/t-takahashi,
 *    staff_code T2026002..T2026061)、非常勤7名、国際科教員、各部局を含む。
 *  - クラス 21（各学年 普通6クラス + 国際科1クラス、教室名 1-1..3-7）→ classes.csv
 *  - 教室 34（普通教室21・特別教室11・予備室2。UI既定の試験教室名 22件を含む）→ basic_rooms.csv
 *  - 教科 9（color_key は UI の教科色）→ subject_groups.csv
 *  - 科目 49（クラス・コース別の開講 offerings・標準試験時間50分・標準教室）→ curriculum_subjects.csv
 *  - 座席（desk_number を持つ30名の座席状態と職員会議室座席表 staff_room 5×6 の30席）
 *
 * 実行: node scripts/create-basic-seed-data.js   （CSV を書き出すだけ。投入は npm run db:seed）
 * 生成物は scripts/seed.js が読み取り、パスワードをハッシュ化して DB へ投入する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');

/** 教科マスタ（code=教科名、color_key は UI 色、sort_order は表示順） */
export const GROUPS = [
  { code: '国語', color: 'amber', sort: 1 },
  { code: '数学', color: 'blue', sort: 2 },
  { code: '社会', color: 'rose', sort: 3 },
  { code: '理科', color: 'teal', sort: 4 },
  { code: '外国語', color: 'orange', sort: 5 },
  { code: '情報', color: 'gray', sort: 6 },
  { code: '保健体育', color: 'green', sort: 7 },
  { code: '技術・家庭', color: 'slate', sort: 8 },
  { code: '芸術', color: 'purple', sort: 9 },
];

/**
 * 教員60名 [id, 姓名, 読み(romaji), grade, department, 教科code, is_parttime]
 * 非常勤は芸術（音楽・美術）6名と国際科の非常勤1名。テスト依存の id と staff_code を保持する。
 */
export const TEACHERS = [
  // ===== 1年（20名）=====
  ['t-tanaka', '田中 先生', 'tanaka', 1, '生徒指導部', '外国語', 0],
  ['t-takahashi', '高橋 先生', 'takahashi', 1, '１学年', '国語', 0],
  ['t-006', '川口 美沙子', 'kawaguchi.misako', 1, '１学年', '国語', 0],
  ['t-007', '松本 拓也', 'matsumoto.takuya', 1, '１学年', '数学', 0],
  ['t-008', '井上 由美子', 'inoue.yumiko', 1, '１学年', '数学', 0],
  ['t-009', '森田 亮介', 'morita.ryosuke', 1, '１学年', '数学', 0],
  ['t-010', '石川 彩香', 'ishikawa.ayaka', 1, '１学年', '社会', 0],
  ['t-011', '小川 健太', 'ogawa.kenta', 1, '１学年', '社会', 0],
  ['t-012', '村田 沙織', 'murata.saori', 1, '１学年', '社会', 0],
  ['t-013', '長谷部 一郎', 'hasebe.ichiro', 1, '１学年', '理科', 0],
  ['t-014', '新井 拓', 'arai.hiroshi', 1, '１学年', '理科', 0],
  ['t-015', '西野 梢', 'nishino.kozue', 1, '特別支援教育', '理科', 0],
  ['t-016', '藤井 千夏', 'fujii.chinatsu', 1, '１学年', '外国語', 0],
  ['t-017', '杉崎 遥', 'sugisaki.haruka', 1, '国際科教員室', '外国語', 0],
  ['t-018', '原田 修', 'harada.shu', 1, '情報教育センター', '情報', 0],
  ['t-019', '今井 明日香', 'imai.asuka', 1, '保健室', '保健体育', 0],
  ['t-020', '坂口 健吾', 'sakaguchi.kengo', 1, '１学年', '保健体育', 0],
  ['t-021', '土田 佳代', 'tsuchida.kayo', 1, '１学年', '技術・家庭', 0],
  ['t-022', '山口 結', 'yamaguchi.musubi', 1, '非常勤', '芸術', 1],
  ['t-023', '渡辺 絵里', 'watanabe.eri', 1, '非常勤', '芸術', 1],
  // ===== 2年（20名）=====
  ['t-sato', '佐藤 先生', 'sato', 2, 'キャリア教育推進室', '数学', 0],
  ['t-024', '西村 真澄', 'nishimura.masumi', 2, '２学年', '国語', 0],
  ['t-025', '東 健人', 'higashi.kento', 2, '２学年', '国語', 0],
  ['t-026', '北原 千晶', 'kitahara.chiaki', 2, '２学年', '国語', 0],
  ['t-027', '尾崎 亮', 'ozaki.ryo', 2, '２学年', '数学', 0],
  ['t-028', '水野 雅子', 'mizuno.masako', 2, '２学年', '社会', 0],
  ['t-029', '安藤 光太郎', 'ando.kotaro', 2, 'キャリア教育推進室', '社会', 0],
  ['t-030', '上田 直人', 'ueda.naoto', 2, '２学年', '社会', 0],
  ['t-031', '森口 泰志', 'moriguchi.yasushi', 2, '２学年', '理科', 0],
  ['t-032', '松井 玲奈', 'matsui.reina', 2, '２学年', '理科', 0],
  ['t-033', '小野寺 巧', 'onodera.takumi', 2, '２学年', '理科', 0],
  ['t-034', '大西 千鶴', 'onishi.chizuru', 2, '２学年', '外国語', 0],
  ['t-035', '野口 沙季', 'noguchi.saki', 2, '２学年', '外国語', 0],
  ['t-036', '増田 愛', 'masuda.ai', 2, '国際科教員室', '外国語', 0],
  ['t-037', '谷口 修平', 'taniguchi.shuhei', 2, '情報教育センター', '情報', 0],
  ['t-038', '小柳 直人', 'oyanagi.naoto', 2, '生徒指導部', '保健体育', 0],
  ['t-039', '木下 大樹', 'kinoshita.hiroki', 2, '２学年', '保健体育', 0],
  ['t-040', '吉田 麻衣', 'yoshida.mai', 2, '２学年', '技術・家庭', 0],
  ['t-041', '江藤 佳名', 'eto.kana', 2, '非常勤', '芸術', 1],
  ['t-042', '高木 詩織', 'takagi.shiori', 2, '非常勤', '芸術', 1],
  // ===== 3年（20名）=====
  ['t-suzuki', '鈴木 先生', 'suzuki', 3, '特色推進室', '理科', 0],
  ['t-043', '青木 修二', 'aoki.shuji', 3, '３学年', '国語', 0],
  ['t-044', '内藤 美咲', 'naito.misaki', 3, '３学年', '国語', 0],
  ['t-045', '外山 雅弘', 'toyama.masahiro', 3, '３学年', '国語', 0],
  ['t-046', '小島 亮太郎', 'kojima.ryotaro', 3, '進路指導部', '数学', 0],
  ['t-047', '平川 拓', 'hirakawa.hiroshi', 3, '３学年', '数学', 0],
  ['t-048', '立花 陽菜', 'tachibana.hina', 3, '３学年', '数学', 0],
  ['t-049', '宮本 誠', 'miyamoto.makoto', 3, '生徒指導部', '社会', 0],
  ['t-050', '杉本 沙織', 'sugimoto.saori', 3, '３学年', '社会', 0],
  ['t-051', '目黒 光太郎', 'meguro.kotaro', 3, '３学年', '社会', 0],
  ['t-052', '海老澤 慎一', 'ebisawa.shinichi', 3, '特色推進室', '理科', 0],
  ['t-053', '小久保 千鶴', 'kokubo.chizuru', 3, '３学年', '外国語', 0],
  ['t-054', '白石 遥', 'shiraishi.haruka', 3, '３学年', '外国語', 0],
  ['t-055', '三宅 愛', 'miyake.ai', 3, '国際科教員室', '外国語', 1],
  ['t-056', '宇佐美 修平', 'usami.shuhei', 3, '情報教育センター', '情報', 0],
  ['t-057', '伊藤 直人', 'ito.naoto', 3, '保健室', '保健体育', 0],
  ['t-058', '和田 大樹', 'wada.hiroki', 3, '３学年', '保健体育', 0],
  ['t-059', '片山 麻衣', 'katayama.mai', 3, '３学年', '技術・家庭', 0],
  ['t-060', '尾形 佳名', 'ogata.kana', 3, '非常勤', '芸術', 1],
  ['t-061', '酒井 詩織', 'sakai.shiori', 3, '非常勤', '芸術', 1],
];

/** クラスマスタ 21（各学年 普通6クラス + 国際科1クラス、教室名は UI 既定の試験教室名 1-1..3-7） */
export const CLASSES = [];
for (let g = 1; g <= 3; g += 1) {
  for (let n = 1; n <= 7; n += 1) {
    const intl = n === 7;
    CLASSES.push({
      id: `cls${g}0${n}`,
      grade: g,
      class_num: n,
      name: `${g}-${n}`,
      short_name: intl ? `${g}-7国際科` : `${g}-${n}`,
      room_id: `room${g}0${n}`,
      seats: intl ? 24 : 36,
      notes: intl ? '国際科（少人数・専門科目あり）' : '普通教室',
    });
  }
}

/** 教室マスタ 34（普通教室21 + 特別教室11 + 予備室2）。UI 既定名 22件をすべて含む。 */
export const ROOMS = CLASSES.map((c) => ({
  id: c.room_id,
  name: c.name,
  room_type: 'CLASS',
  seats: c.seats,
  grades: [c.grade],
  notes: c.notes,
}));

const SPECIAL_ROOMS = [
  ['room227', '227', 'SPECIAL', 40, [1, 2, 3], '社会科教室（地図・資料）'],
  ['room212', '212', 'SPECIAL', 36, [1, 2, 3], '情報処理室（PC36台）'],
  ['room312', '312', 'SPECIAL', 36, [1, 2, 3], '美術室（鑑賞・造形）'],
  ['room405', '405', 'SPECIAL', 40, [1, 2, 3], '多目的教室（large グループ）'],
  ['room-music', '音楽室', 'SPECIAL', 40, [1, 2, 3], '器楽・合唱'],
  ['room-shodo', '書道室', 'SPECIAL', 24, [1, 2, 3], '書道'],
  ['room-sci1', '理科実験室（1）', 'SPECIAL', 36, [1, 2, 3], '化学系実験'],
  ['room-sci2', '理科実験室（2）', 'SPECIAL', 36, [1, 2, 3], '生物・物理系実験'],
  ['room-home', '家庭技術室', 'SPECIAL', 32, [1, 2, 3], '技術・家庭（食物・製図）'],
  ['room-av', '視聴覚教室', 'SPECIAL', 60, [1, 2, 3], 'LCT・上映'],
  ['room-gym', '体育館', 'GYM', 200, [1, 2, 3], '体育・式典'],
  ['room-prep1', '予備室1', 'SPECIAL', 30, [1, 2, 3], '考査予備室（1年フロア）'],
  ['room-prep2', '予備室2', 'SPECIAL', 30, [1, 2, 3], '考査予備室（3年フロア）'],
];
ROOMS.push(...SPECIAL_ROOMS.map(([id, name, room_type, seats, grades, notes]) => ({ id, name, room_type, seats, grades, notes })));

/**
 * 科目マスタ 49（年間開講）。pattern は開講クラス番号一覧:
 *   all=7クラス / odd=1,3,5組 / even=2,4,6組 / intl=7組(国際科) / art3=1,4,7組
 */
const OFFER = {
  all: [1, 2, 3, 4, 5, 6, 7],
  odd: [1, 3, 5],
  even: [2, 4, 6],
  intl: [7],
  art3: [1, 4, 7],
};

export const CURRICULUM = [
  // 1年 (16)
  ['crs101', '国語総合', '国総', '国語', 1, 'all', 50, '現代文・文法'],
  ['crs102', '数学Ⅰ', '数Ⅰ', '数学', 1, 'all', 50, '数と式・集合'],
  ['crs103', '数学A', '数A', '数学', 1, 'all', 50, '集合・論理・整数'],
  ['crs104', 'コミュニケーション英語Ⅰ', '英Ⅰ', '外国語', 1, 'all', 50, '読み・聞き'],
  ['crs105', '地理探究', '地理', '社会', 1, 'all', 50, '地勢・地形図'],
  ['crs106', '日本史探究', '日本史', '社会', 1, 'all', 50, '近世〜近代'],
  ['crs107', '現代社会', '現社', '社会', 1, 'all', 50, '憲法・市場'],
  ['crs108', '化学基礎', '化基', '理科', 1, 'all', 50, '物質・変化'],
  ['crs109', '生物基礎', '生基', '理科', 1, 'all', 50, '細胞と生命'],
  ['crs110', '情報基礎', '情報基', '情報', 1, 'all', 50, 'プログラミング基礎'],
  ['crs111', '保健体育', '保体', '保健体育', 1, 'all', 50, '理論（健康・運動）'],
  ['crs112', '技術・家庭', '技術家庭', '技術・家庭', 1, 'all', 50, '技術分野'],
  ['crs113', '音楽Ⅰ', '音楽Ⅰ', '芸術', 1, 'odd', 50, '選択制（器楽・合唱）'],
  ['crs114', '美術Ⅰ', '美術Ⅰ', '芸術', 1, 'even', 50, '選択制（鑑賞・造形）'],
  ['crs115', '国際関係論', '国際関係', '外国語', 1, 'intl', 50, '国際科専門'],
  ['crs116', '英語リーダー', 'リーダー', '外国語', 1, 'intl', 50, '国際科専門'],
  // 2年 (18)
  ['crs201', '現代文B', '現文B', '国語', 2, 'all', 50, '現代文B'],
  ['crs202', '古典B', '古典B', '国語', 2, 'all', 50, '漢文・文語文法'],
  ['crs203', '数学Ⅱ', '数Ⅱ', '数学', 2, 'all', 50, '二次関数・指数対数'],
  ['crs204', '数学B', '数B', '数学', 2, 'all', 50, '数列・ベクトル'],
  ['crs205', 'コミュニケーション英語Ⅱ', '英Ⅱ', '外国語', 2, 'all', 50, '読み・聞き'],
  ['crs206', '日本史探究', '日本史', '社会', 2, 'all', 50, '近現代'],
  ['crs207', '地理探究', '地理', '社会', 2, 'all', 50, '世界地理'],
  ['crs208', '現代社会', '現社', '社会', 2, 'all', 50, '現代社会'],
  ['crs209', '化学基礎', '化基', '理科', 2, 'all', 50, '物質変化'],
  ['crs210', '生物基礎', '生基', '理科', 2, 'all', 50, '遺伝と生態'],
  ['crs211', '情報科学', '情報科', '情報', 2, 'all', 50, 'データとアルゴリズム'],
  ['crs212', '保健体育', '保体', '保健体育', 2, 'all', 50, '理論'],
  ['crs213', '技術・家庭', '技術家庭', '技術・家庭', 2, 'all', 50, '技術分野'],
  ['crs214', '音楽Ⅱ', '音楽Ⅱ', '芸術', 2, 'odd', 50, '選択制'],
  ['crs215', '美術Ⅱ', '美術Ⅱ', '芸術', 2, 'even', 50, '選択制'],
  ['crs216', '書道Ⅰ', '書道', '芸術', 2, 'art3', 50, '書道選択（書道室）'],
  ['crs217', '英語表現', '英表', '外国語', 2, 'intl', 50, '国際科専門'],
  ['crs218', '世界史探究', '世界史', '社会', 2, 'intl', 50, '国際科社会'],
  // 3年 (15)
  ['crs301', '現代文B', '現文B', '国語', 3, 'all', 50, '現代文B'],
  ['crs302', '古典B', '古典B', '国語', 3, 'all', 50, '文語文法・文学'],
  ['crs303', '数学Ⅲ', '数Ⅲ', '数学', 3, 'all', 50, '指数・対数・微積分'],
  ['crs304', '数学C', '数C', '数学', 3, 'all', 50, '図形と方程式'],
  ['crs305', 'コミュニケーション英語Ⅲ', '英Ⅲ', '外国語', 3, 'all', 50, '読み・聞き'],
  ['crs306', '日本史探究', '日本史', '社会', 3, 'all', 50, '近現代'],
  ['crs307', '政治経済', '政経', '社会', 3, 'all', 50, '政治・経済'],
  ['crs308', '化学', '化学', '理科', 3, 'all', 50, '理論・無機'],
  ['crs309', '生物', '生物', '理科', 3, 'all', 50, '遺伝・生態'],
  ['crs310', '物理', '物理', '理科', 3, 'all', 50, '力学・電磁気'],
  ['crs311', '情報科学', '情報科', '情報', 3, 'all', 50, '情報処理'],
  ['crs312', '保健体育', '保体', '保健体育', 3, 'all', 50, '理論'],
  ['crs313', '芸術選択', '芸選', '芸術', 3, 'all', 50, '音楽・美術選択'],
  ['crs314', '国際関係論', '国際関係', '外国語', 3, 'intl', 50, '国際科専門'],
  ['crs315', '英語表現Ⅲ', '英表Ⅲ', '外国語', 3, 'intl', 50, '国際科専門'],
];


/** 科目の標準教室（group/pattern から決める。'own' は各クラスの自教室） */
function roomFor(group, pattern) {
  if (group === '芸術') {
    if (pattern === 'odd') return 'room-music';
    if (pattern === 'even') return 'room312';
    if (pattern === 'art3') return 'room-shodo';
    return 'own';
  }
  if (group === '情報') return 'room212';
  if (group === '技術・家庭') return 'room-home';
  return 'own';
}

/** 科目マスタ行（offerings はクラス・コース別の開講と標準教室） */
export const CURRICULUM_ROWS = CURRICULUM.map(([id, name, short, group, grade, pattern, duration, notes], i) => {
  const roomKey = roomFor(group, pattern);
  const offerings = OFFER[pattern].map((n) => {
    const cls = CLASSES.find((c) => c.grade === grade && c.class_num === n);
    return { grade, class_course_id: cls.id, room_id: roomKey === 'own' ? cls.room_id : roomKey };
  });
  return {
    id,
    name,
    short_name: short,
    subject_id: `subj${String(GROUPS.findIndex((g) => g.code === group) + 1).padStart(2, '0')}`,
    grade,
    offerings: JSON.stringify(offerings),
    default_room_id: offerings[0].room_id,
    default_duration: duration,
    is_active: true,
    sort_order: i + 1,
    notes,
  };
});

/** 職員会議室（staff_room）の座席。A-01..E-06 の30席を教職員30名へ割り当てる。 */
export const DESKS = {
  'u-002': ['A-01', 'staff'],
  'u-001': ['A-02', 'staff'],
  't-tanaka': ['A-03', 'staff'],
  't-038': ['A-04', 'staff'],
  't-049': ['A-05', 'staff'],
  't-sato': ['A-06', 'staff'],
  't-takahashi': ['B-01', 'staff'],
  't-029': ['B-02', 'staff'],
  't-suzuki': ['B-03', 'staff'],
  't-052': ['B-04', 'staff'],
  't-015': ['B-05', 'staff'],
  't-017': ['B-06', 'staff'],
  't-019': ['C-01', 'nurse'],
  't-057': ['C-02', 'nurse'],
  't-018': ['C-03', 'it-center'],
  't-037': ['C-04', 'it-center'],
  't-056': ['C-05', 'it-center'],
  't-036': ['C-06', 'staff'],
  't-006': ['D-01', 'staff'],
  't-007': ['D-02', 'staff'],
  't-008': ['D-03', 'staff'],
  't-009': ['D-04', 'staff'],
  't-010': ['D-05', 'staff'],
  't-011': ['D-06', 'staff'],
  't-012': ['E-01', 'staff'],
  't-013': ['E-02', 'staff'],
  't-016': ['E-03', 'staff'],
  't-021': ['E-04', 'staff'],
  't-028': ['E-05', 'staff'],
  't-043': ['E-06', 'staff'],
};

/** 教職員 62名（管理者・教務主任 + 教員60名）。users.csv の元データ。 */
export const USERS = [
  {
    id: 'u-001', staff_code: 'T2026000', name: 'システム管理者', email: 'admin@school.ed.jp',
    role: 'sys-admin', grade: '', department: '情報システム室', extension_number: '100',
    subjects: [], is_parttime: 0,
  },
  {
    id: 'u-002', staff_code: 'T2026001', name: '教務 主任', email: 'kyomu@school.ed.jp',
    role: 'kyomu', grade: '', department: '教務部', extension_number: '101',
    subjects: [], is_parttime: 0,
  },
  ...TEACHERS.map(([id, name, romaji, grade, department, group, parttime], i) => ({
    id,
    staff_code: `T2026${String(i + 2).padStart(3, '0')}`,
    name,
    email: `${romaji}@school.ed.jp`,
    role: 'teacher',
    grade: String(grade),
    department,
    extension_number: String(102 + i),
    subjects: [group],
    is_parttime: parttime,
  })),
];

/** 座席状態（desk_number を持つ30名。current_status は PRESENT） */
export const SEATING = USERS.filter((u) => DESKS[u.id]).map((u) => {
  const [desk_number, group_zone] = DESKS[u.id];
  return {
    id: `seat_${u.id}`,
    user_id: u.id,
    desk_number,
    group_zone,
    current_status: 'PRESENT',
    status_note: '',
  };
});

/** 職員会議室座席表（staff_room 5×6。desk_number のアルファベットが行、番号が列） */
export const SEAT_MATRIX = {
  id: 'staff_room',
  name: '職員会議室 座席表',
  rows: 5,
  cols: 6,
  cells: SEATING.map((s) => ({
    row: s.desk_number.charCodeAt(0) - 64,
    col: Number(s.desk_number.slice(2)),
    user_id: s.user_id,
  })),
};


/** CSVセルの引用（カンマ・引用符・改行を含む値は "...\" でくるむ） */
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';

const subjectRows = GROUPS.map((g, i) => [`subj${String(i + 1).padStart(2, '0')}`, g.code, g.sort, g.color]);
const classRows = CLASSES.map((c) => [c.id, c.grade, c.class_num, c.name, c.short_name, true]);
const roomRows = ROOMS.map((r) => [r.id, r.name, r.room_type, r.seats, JSON.stringify(r.grades), true, r.notes]);
const curriculumRows = CURRICULUM_ROWS.map((c) => [
  c.id, c.name, c.short_name, c.subject_id, c.grade, c.offerings, c.default_room_id,
  c.default_duration, true, c.sort_order, c.notes,
]);
const userRows = USERS.map((u) => [
  u.id, u.staff_code, u.name, u.email, u.role, u.grade, u.department, u.extension_number,
  JSON.stringify(u.subjects), u.is_parttime,
  DESKS[u.id] ? DESKS[u.id][0] : '', DESKS[u.id] ? DESKS[u.id][1] : '',
]);

const FILES = [
  ['subject_groups.csv', csv(['id', 'name', 'sort_order', 'color_key'], subjectRows)],
  ['classes.csv', csv(['id', 'grade', 'class_num', 'name', 'short_name', 'is_active'], classRows)],
  ['basic_rooms.csv', csv(['id', 'name', 'room_type', 'seats', 'grades', 'is_active', 'notes'], roomRows)],
  ['curriculum_subjects.csv', csv(
    ['id', 'name', 'short_name', 'subject_id', 'grade', 'offerings', 'default_room_id', 'default_duration', 'is_active', 'sort_order', 'notes'],
    curriculumRows
  )],
  ['users.csv', csv(
    ['id', 'staff_code', 'name', 'email', 'role', 'grade', 'department', 'extension_number', 'subjects', 'is_parttime', 'desk_number', 'group_zone'],
    userRows
  )],
];

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  for (const [name, text] of FILES) fs.writeFileSync(path.join(SEED_DIR, name), text, 'utf8');
  console.log(
    `[basic-seed] 教職員${userRows.length}・クラス${classRows.length}・教科${subjectRows.length}・科目${curriculumRows.length}・教室${roomRows.length}・座席${SEATING.length}席 を data/seed/ へ書き出した`
  );
  console.log(`[basic-seed] 科目の先頭=${curriculumRows[0][1]} 最後=${curriculumRows[curriculumRows.length - 1][1]}`);
}

