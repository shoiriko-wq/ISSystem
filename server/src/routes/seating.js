const express = require('express');
const router = express.Router();

// --------------------------------------------------
// インメモリデータ（初期値の更新）
// --------------------------------------------------

// 授業（講座）マスター
let courses = [
  { id: 1, code: 'INFO-1A', name: '1年 情報Ⅰ (A群)' },
  { id: 2, code: 'MUS-1',  name: '1年 芸術選択 (音楽)' },
  { id: 3, code: 'ART-1',  name: '1年 芸術選択 (美術)' }
];

// 生徒マスター（全校生徒）
let students = [
  {
    id: '1101',
    student_number: 1,
    class_code: '1-1',
    name: '相田 拓海',
    kana: 'あいだ たくみ',
    gender: '男',
    club: 'サッカー部',
    subject_option: '美術Ⅰ'
  },
  {
    id: '1102',
    student_number: 2,
    class_code: '1-1',
    name: '伊藤 葵',
    kana: 'いとう あおい',
    gender: '女',
    club: '吹奏楽部',
    subject_option: '音楽Ⅰ'
  },
  {
    id: '1305',
    student_number: 5,
    class_code: '1-3',
    name: '遠藤 さくら',
    kana: 'えんどう さくら',
    gender: '女',
    club: '陸上部',
    subject_option: '音楽Ⅰ'
  }
];

// 授業受講名簿
let courseStudents = [
  { course_id: 1, student_id: '1101' },
  { course_id: 1, student_id: '1102' },
  { course_id: 1, student_id: '1305' },
  { course_id: 2, student_id: '1102' },
  { course_id: 2, student_id: '1305' }
];

// レイアウト設定 (alignment と pattern を追加)
let layouts = [
  { 
    course_id: 1, 
    layout_type: 'custom_columns', 
    cols: 6, 
    column_counts: [6, 7, 7, 7, 7, 6], 
    pattern: '677776',
    alignment: 'back', // 'back'(後ろ詰め) または 'front'(前詰め)
    podium_position: 'top' 
  }
];

// 座席配置データ
let seatAssignments = [
  { course_id: 1, seat_index: 0, student_id: '1101' },
  { course_id: 1, seat_index: 1, student_id: '1102' },
  { course_id: 1, seat_index: 2, student_id: '1305' }
];

// --------------------------------------------------
// 授業（講座）管理 API
// --------------------------------------------------
router.get('/courses', (req, res) => res.json(courses));

router.post('/courses', (req, res) => {
  const { name, code } = req.body;
  if (!name) return res.status(400).json({ error: '授業（講座）名は必須です' });
  
  const newId = courses.length ? Math.max(...courses.map(c => c.id)) + 1 : 1;
  const newCourse = { id: newId, code: code || `C-${newId}`, name };
  courses.push(newCourse);

  // 初期レイアウトの割り当て
  layouts.push({
    course_id: newId,
    layout_type: 'custom_columns',
    cols: 6,
    column_counts: [6, 7, 7, 7, 7, 6],
    pattern: '677776',
    alignment: 'back',
    podium_position: 'top'
  });

  res.status(201).json(newCourse);
});

router.delete('/courses/:id', (req, res) => {
  const courseId = parseInt(req.params.id);
  courses = courses.filter(c => c.id !== courseId);
  courseStudents = courseStudents.filter(cs => cs.course_id !== courseId);
  layouts = layouts.filter(l => l.course_id !== courseId);
  seatAssignments = seatAssignments.filter(sa => sa.course_id !== courseId);
  res.json({ message: '授業情報を削除しました' });
});

// --------------------------------------------------
// 授業用 受講生徒名簿 API
// --------------------------------------------------
router.get('/course-students', (req, res) => {
  const courseId = parseInt(req.query.course_id);
  if (!courseId) return res.status(400).json({ error: 'course_id は必須です' });

  const assignedStudentIds = courseStudents
    .filter(cs => cs.course_id === courseId)
    .map(cs => String(cs.student_id));

  const enrolledStudents = students.filter(s => assignedStudentIds.includes(String(s.id)));
  res.json(enrolledStudents);
});

router.post('/course-students', (req, res) => {
  const { course_id, student_ids } = req.body;
  const courseId = parseInt(course_id);

  if (!courseId || !Array.isArray(student_ids)) {
    return res.status(400).json({ error: '有効な course_id および student_ids が必要です' });
  }

  courseStudents = courseStudents.filter(cs => cs.course_id !== courseId);

  student_ids.forEach(sId => {
    courseStudents.push({
      course_id: courseId,
      student_id: String(sId)
    });
  });

  res.json({ message: '受講生徒名簿を更新しました', count: student_ids.length });
});

// --------------------------------------------------
// 全校生徒マスター API
// --------------------------------------------------
router.get('/students', (req, res) => {
  res.json(students);
});

router.post('/students', (req, res) => {
  const { id, student_number, class_code, name, kana, gender, club, subject_option } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: '生徒ID(年組番4桁)と氏名は必須です' });
  }

  const studentId = String(id);
  const existingIndex = students.findIndex(s => String(s.id) === studentId);

  const studentData = {
    id: studentId,
    student_number: parseInt(student_number) || parseInt(studentId.slice(-2)) || 0,
    class_code: class_code || '',
    name,
    kana: kana || '',
    gender: gender || '未設定',
    club: club || '',
    subject_option: subject_option || ''
  };

  if (existingIndex !== -1) {
    students[existingIndex] = studentData;
  } else {
    students.push(studentData);
  }

  res.status(201).json(studentData);
});

router.post('/students/bulk', (req, res) => {
  const { students: newStudentsList } = req.body;
  if (!Array.isArray(newStudentsList) || newStudentsList.length === 0) {
    return res.status(400).json({ error: '有効な生徒データがありません' });
  }

  let count = 0;
  newStudentsList.forEach(s => {
    if (!s.id || !s.name) return;

    const studentId = String(s.id).trim();
    const existingIndex = students.findIndex(item => String(item.id) === studentId);

    const studentData = {
      id: studentId,
      student_number: parseInt(s.student_number) || parseInt(studentId.slice(-2)) || 0,
      class_code: s.class_code || '',
      name: s.name,
      kana: s.kana || '',
      gender: s.gender || '未設定',
      club: s.club || '',
      subject_option: s.subject_option || ''
    };

    if (existingIndex !== -1) {
      students[existingIndex] = studentData;
    } else {
      students.push(studentData);
    }
    count++;
  });

  res.json({ message: '全校生徒データの一括登録が完了しました', count });
});

router.delete('/students/:id', (req, res) => {
  const id = String(req.params.id);
  students = students.filter(s => String(s.id) !== id);
  courseStudents = courseStudents.filter(cs => String(cs.student_id) !== id);
  seatAssignments = seatAssignments.filter(sa => String(sa.student_id) !== id);
  res.json({ message: '生徒情報を削除しました' });
});

// --------------------------------------------------
// レイアウト API 【修正箇所】
// --------------------------------------------------
router.get('/layout/:course_id', (req, res) => {
  const courseId = parseInt(req.params.course_id);
  let layout = layouts.find(l => l.course_id === courseId);

  if (!layout) {
    layout = {
      course_id: courseId,
      layout_type: 'custom_columns',
      cols: 6,
      column_counts: [6, 7, 7, 7, 7, 6],
      pattern: '677776',
      alignment: 'back',
      podium_position: 'top'
    };
  }

  res.json(layout);
});

router.post('/layout/:course_id', (req, res) => {
  const courseId = parseInt(req.params.course_id);
  const { layout_type, rows, cols, column_counts, pattern, alignment, podium_position } = req.body;

  let layout = layouts.find(l => l.course_id === courseId);
  if (!layout) {
    layout = { course_id: courseId };
    layouts.push(layout);
  }

  // パターン文字列（例: "677776"）または配列（[6,7,7,7,7,6]）の相互変換処理
  let formattedPattern = pattern;
  let formattedCounts = column_counts;

  if (pattern && !column_counts) {
    formattedCounts = pattern.split('').map(n => parseInt(n, 10) || 0);
  } else if (Array.isArray(column_counts) && !pattern) {
    formattedPattern = column_counts.join('');
  }

  layout.layout_type = layout_type || 'custom_columns';
  layout.rows = parseInt(rows) || 6;
  layout.cols = formattedCounts ? formattedCounts.length : (parseInt(cols) || 6);
  layout.column_counts = formattedCounts || [6, 7, 7, 7, 7, 6];
  layout.pattern = formattedPattern || '677776';
  layout.alignment = alignment || 'back'; // 'back' または 'front'
  layout.podium_position = podium_position || 'top';

  res.json(layout);
});

// --------------------------------------------------
// 座席配置 API
// --------------------------------------------------
router.get('/assignments/:course_id', (req, res) => {
  const courseId = parseInt(req.params.course_id);
  res.json(seatAssignments.filter(sa => sa.course_id === courseId));
});

router.post('/assignments/:course_id', (req, res) => {
  const courseId = parseInt(req.params.course_id);
  const { assignments } = req.body;

  seatAssignments = seatAssignments.filter(sa => sa.course_id !== courseId);

  if (Array.isArray(assignments)) {
    assignments.forEach(item => {
      if (item.student_id !== undefined && item.student_id !== null && item.student_id !== '') {
        seatAssignments.push({
          course_id: courseId,
          seat_index: parseInt(item.seat_index),
          student_id: String(item.student_id)
        });
      }
    });
  }

  res.json({ message: '座席配置を更新しました' });
});

// 自動シャッフル API
router.post('/assignments/:course_id/shuffle', (req, res) => {
  const courseId = parseInt(req.params.course_id);

  const assignedStudentIds = courseStudents
    .filter(cs => cs.course_id === courseId)
    .map(cs => String(cs.student_id));

  const enrolledStudents = students.filter(s => assignedStudentIds.includes(String(s.id)));

  const layout = layouts.find(l => l.course_id === courseId) || { layout_type: 'custom_columns', column_counts: [6, 7, 7, 7, 7, 6] };
  let totalSeats = 36;
  if (layout.column_counts) {
    totalSeats = layout.column_counts.reduce((a, b) => a + b, 0);
  } else if (layout.rows && layout.cols) {
    totalSeats = layout.rows * layout.cols;
  }

  const shuffled = [...enrolledStudents];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  seatAssignments = seatAssignments.filter(sa => sa.course_id !== courseId);
  const newAssignments = [];

  shuffled.forEach((student, index) => {
    if (index < totalSeats) {
      const item = { course_id: courseId, seat_index: index, student_id: String(student.id) };
      seatAssignments.push(item);
      newAssignments.push(item);
    }
  });

  res.json({ message: '席替えが完了しました', assignments: newAssignments });
});

module.exports = router;