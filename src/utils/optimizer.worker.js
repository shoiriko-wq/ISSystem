/**
 * ISSystem Periodic Exam Proctor Optimization Worker
 * 定期考査試験監督自動最適化ソルバー (Worker Threads / メタヒューリスティクス: 焼きなまし法 + 遺伝的アルゴリズム)
 */

import { parentPort, workerData } from 'worker_threads';

/**
 * メイン最適化エントリーポイント
 */
function runOptimizer() {
  try {
    const { examMaster, slots, teachers, classes, constraintWeights } = workerData;

    // 重み付け設定 (デフォルト値のセット)
    const weights = {
      selfSubjectViolation: constraintWeights?.selfSubjectViolation || 10000, // 自教科監督不可 (絶対制約)
      teacherTimeOverlap: constraintWeights?.teacherTimeOverlap || 10000,   // 同一時間帯重複不可 (絶対制約)
      unassignedSlotPenalty: constraintWeights?.unassignedSlotPenalty || 5000, // 監督未割り当てペナルティ
      dailyLimitExceeded: constraintWeights?.dailyLimitExceeded || 1000,     // 1日あたりの担当上限オーバー
      consecutiveExceeded: constraintWeights?.consecutiveExceeded || 500,    // 連続コマ制限オーバー
      imbalancePenalty: constraintWeights?.imbalancePenalty || 100,           // 担当回数の偏りペナルティ
    };

    // 初期解の生成 (ランダム・ヒューリスティック割り当て)
    let currentSolution = generateInitialSolution(slots, teachers, classes);
    let currentCost = evaluateSolution(currentSolution, slots, teachers, classes, weights);

    let bestSolution = JSON.parse(JSON.stringify(currentSolution));
    let bestCost = currentCost;

    // 焼きなまし法 (Simulated Annealing) パラメータ
    let temp = 1000.0;
    const coolingRate = 0.995;
    const minTemp = 0.01;
    const maxIterations = 20000;

    for (let iter = 0; iter < maxIterations && temp > minTemp; iter++) {
      // 近傍解の生成 (1〜2箇所の監督を入れ替えまたは再割り当て)
      const neighborSolution = generateNeighborSolution(currentSolution, teachers);
      const neighborCost = evaluateSolution(neighborSolution, slots, teachers, classes, weights);

      // コスト差分の計算
      const deltaCost = neighborCost - currentCost;

      // 遷移判定 (メトロポリス基準)
      if (deltaCost < 0 || Math.exp(-deltaCost / temp) > Math.random()) {
        currentSolution = neighborSolution;
        currentCost = neighborCost;

        // 最良解の更新
        if (currentCost < bestCost) {
          bestSolution = JSON.parse(JSON.stringify(currentSolution));
          bestCost = currentCost;
        }
      }

      temp *= coolingRate;

      // 進捗状況をメインスレッドへ中間通知 (1000イテレーション毎)
      if (iter % 1000 === 0 && parentPort) {
        parentPort.postMessage({
          type: 'PROGRESS',
          progress: Math.round((iter / maxIterations) * 100),
          currentCost: bestCost,
        });
      }
    }

    // 最終解のバリデーションと矛盾検出
    const finalValidation = validateSolution(bestSolution, slots, teachers, classes);

    // 完了結果をメインスレッドへ送信
    if (parentPort) {
      parentPort.postMessage({
        type: 'COMPLETED',
        solution: bestSolution,
        score: bestCost,
        conflicts: finalValidation,
      });
    }
  } catch (error) {
    if (parentPort) {
      parentPort.postMessage({
        type: 'ERROR',
        error: error.message,
      });
    }
  }
}

/**
 * 初期解の生成
 */
function generateInitialSolution(slots, teachers, classes) {
  const assignments = {};

  slots.forEach((slot) => {
    // 該当コマに試験が設定されているクラスを取得
    const activeClasses = classes.filter((c) => slot.subjects && slot.subjects[c.id]);

    activeClasses.forEach((cls) => {
      const slotKey = `${slot.day_number}_${slot.slot_number}_${cls.id}`;
      // ランダムに教員を選択して初期割り当て
      const randomTeacher = teachers[Math.floor(Math.random() * teachers.length)];
      assignments[slotKey] = randomTeacher ? randomTeacher.id : null;
    });
  });

  return assignments;
}

/**
 * 近傍解の生成 (Mutation / Neighborhood Search)
 */
function generateNeighborSolution(solution, teachers) {
  const neighbor = { ...solution };
  const keys = Object.keys(neighbor);

  if (keys.length === 0) return neighbor;

  // 1〜2個のスロットをランダム選択して教員を変更
  const mutateCount = Math.random() < 0.3 ? 2 : 1;

  for (let i = 0; i < mutateCount; i++) {
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    const randomTeacher = teachers[Math.floor(Math.random() * teachers.length)];
    neighbor[randomKey] = randomTeacher ? randomTeacher.id : null;
  }

  return neighbor;
}

/**
 * コスト評価関数 (制約違反の最小化)
 */
function evaluateSolution(solution, slots, teachers, classes, weights) {
  let penalty = 0;

  // 教員ごとの担当コマ集計用
  const teacherCounts = {};
  const teacherTimeSlots = {}; // `${teacherId}_${day}_${slot}`

  teachers.forEach((t) => {
    teacherCounts[t.id] = 0;
  });

  // 各スロットごとの制約判定
  slots.forEach((slot) => {
    const activeClasses = classes.filter((c) => slot.subjects && slot.subjects[c.id]);

    activeClasses.forEach((cls) => {
      const slotKey = `${slot.day_number}_${slot.slot_number}_${cls.id}`;
      const teacherId = solution[slotKey];
      const subjectId = slot.subjects[cls.id];

      if (!teacherId) {
        penalty += weights.unassignedSlotPenalty;
        return;
      }

      teacherCounts[teacherId] = (teacherCounts[teacherId] || 0) + 1;

      // 1. 同一時間帯における重なり制約
      const timeKey = `${teacherId}_${slot.day_number}_${slot.slot_number}`;
      if (teacherTimeSlots[timeKey]) {
        penalty += weights.teacherTimeOverlap;
      } else {
        teacherTimeSlots[timeKey] = true;
      }

      // 2. 自教科監督の禁止制約
      const teacher = teachers.find((t) => t.id === teacherId);
      if (teacher && teacher.subject_id === subjectId) {
        penalty += weights.selfSubjectViolation;
      }
    });
  });

  // 3. 担当回数の平準化 (分散ペナルティ)
  const counts = Object.values(teacherCounts);
  if (counts.length > 0) {
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, count) => sum + Math.pow(count - avg, 2), 0) / counts.length;
    penalty += Math.round(variance * weights.imbalancePenalty);
  }

  return penalty;
}

/**
 * 最終解に対する詳細矛盾診断
 */
function validateSolution(solution, slots, teachers, classes) {
  const errors = [];
  const warnings = [];

  slots.forEach((slot) => {
    const activeClasses = classes.filter((c) => slot.subjects && slot.subjects[c.id]);

    activeClasses.forEach((cls) => {
      const slotKey = `${slot.day_number}_${slot.slot_number}_${cls.id}`;
      const teacherId = solution[slotKey];
      const subjectId = slot.subjects[cls.id];

      if (!teacherId) {
        errors.push(`${slot.day_number}日目 ${slot.slot_number}限 ${cls.name}: 監督が割り当てられていません。`);
        return;
      }

      const teacher = teachers.find((t) => t.id === teacherId);
      if (teacher && teacher.subject_id === subjectId) {
        errors.push(`${slot.day_number}日目 ${slot.slot_number}限 ${cls.name}: ${teacher.name} 先生が自教科の試験監督に割り当てられています。`);
      }
    });
  });

  return { errors, warnings };
}

// ワークスレッドの実行開始
runOptimizer();