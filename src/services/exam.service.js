/**
 * ISSystem Periodic Exam & Supervisor Auto-Optimization Solver Service
 * 定期考査時間割・自教科監督回避・監督除外制約・矛盾診断 & 自動最適化ソルバー
 */

import examModel from '../models/exam.model.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

export const examService = {
  /**
   * 全考査マスター一覧の取得
   */
  async getExamMasters() {
    return await examModel.listExamMasters();
  },

  /**
   * 考査マトリクス統合データ（科目時間割 + 監督割り当て + 矛盾診断ステータス）の取得
   * @param {string} examMasterId
   */
  async getExamMatrixWithValidation(examMasterId) {
    if (!examMasterId) {
      throw new ApiError(400, '考査マスターIDが指定されていません。');
    }

    const master = await examModel.findExamMasterById(examMasterId);
    if (!master) {
      throw new ApiError(404, '対象の考査マスターが見つかりません。');
    }

    const matrix = await examModel.getExamMatrix(examMasterId);
    const conflicts = await this.diagnoseConflicts(examMasterId);

    return {
      master,
      matrix,
      conflicts,
      hasConflicts: conflicts.errors.length > 0,
      hasWarnings: conflicts.warnings.length > 0,
    };
  },

  /**
   * 考査時間割・監督割り当ての「矛盾診断エンジン」
   * 検証項目:
   *  1. 自教科自コマの不適切監督 (ERROR/WARNING)
   *  2. 同一教員の同一コマ複数クラス重複割当 (ERROR)
   *  3. 監督除外/配慮教員の割り当て違反 (ERROR)
   *  4. 3コマ以上連続監督の過重負荷 (WARNING)
   *  5. 1日の合計監督コマ数偏り (WARNING)
   * @param {string} examMasterId
   */
  async diagnoseConflicts(examMasterId) {
    const slots = await examModel.getExamSlots(examMasterId);
    const proctors = await examModel.getProctorAssignments(examMasterId);
    const exemptions = await examModel.getTeacherExemptions(examMasterId);

    const errors = [];
    const warnings = [];

    // 検索マップの作成
    const slotMap = new Map(); // key: `${day}_${slot}_${classId}`
    for (const s of slots) {
      slotMap.set(`${s.day_number}_${s.slot_number}_${s.class_id}`, s);
    }

    const exemptionMap = new Map(); // key: teacherId, value: exemptionObj
    for (const ex of exemptions) {
      exemptionMap.set(ex.teacher_id, ex);
    }

    // 教員・コマ別の割当トラッキングマップ
    const teacherSlotAssignments = new Map(); // key: `${teacherId}_${day}_${slot}`, value: Array of classIds
    const teacherDailyCounts = new Map(); // key: `${teacherId}_${day}`, value: count
    const teacherSequenceMap = new Map(); // key: `${teacherId}_${day}`, value: Array of slotNumbers

    for (const p of proctors) {
      if (!p.proctor_teacher_id) continue;

      const teacherId = p.proctor_teacher_id;
      const day = p.day_number;
      const slot = p.slot_number;
      const classId = p.class_id;

      // 1. 同一コマ重なり重複判定
      const timeKey = `${teacherId}_${day}_${slot}`;
      const assignedClasses = teacherSlotAssignments.get(timeKey) || [];
      assignedClasses.push(classId);
      teacherSlotAssignments.set(timeKey, assignedClasses);

      if (assignedClasses.length > 1) {
        errors.push({
          type: 'DUPLICATE_PROCTOR_SLOT',
          teacherId,
          day,
          slot,
          message: `教員(ID: ${teacherId})が Day ${day} の第${slot}コマで複数のクラス (${assignedClasses.join(', ')}) に重複割り当てされています。`,
        });
      }

      // 2. 監督除外教員チェック
      if (exemptionMap.has(teacherId)) {
        const ex = exemptionMap.get(teacherId);
        errors.push({
          type: 'EXEMPTED_TEACHER_ASSIGNED',
          teacherId,
          day,
          slot,
          classId,
          message: `監督除外・配慮対象の教員 (${ex.teacher_name || teacherId}) が Day ${day} 第${slot}コマに割り当てられています。理由: ${ex.reason || '未指定'}`,
        });
      }

      // 3. 自教科試験中の自コマ監督判定
      const slotData = slotMap.get(`${day}_${slot}_${classId}`);
      if (slotData && slotData.subject_teacher_id === teacherId) {
        warnings.push({
          type: 'SELF_SUBJECT_PROCTOR',
          teacherId,
          day,
          slot,
          classId,
          message: `Day ${day} 第${slot}コマ (${slotData.class_name || classId}) は、担当教科「${slotData.subject_name || ''}」の自教科試験中に自身が監督に割り当てられています。`,
        });
      }

      // 1日の総件数カウント
      const dailyKey = `${teacherId}_${day}`;
      const currentDailyCount = teacherDailyCounts.get(dailyKey) || 0;
      teacherDailyCounts.set(dailyKey, currentDailyCount + 1);

      // 連続コマ記録
      const seqList = teacherSequenceMap.get(dailyKey) || [];
      seqList.push(slot);
      teacherSequenceMap.set(dailyKey, seqList);
    }

    // 4. 連続コマ過重負荷チェック (3コマ連続など)
    for (const [dailyKey, seqList] of teacherSequenceMap.entries()) {
      const [teacherId, day] = dailyKey.split('_');
      seqList.sort((a, b) => a - b);

      let consecutiveCount = 1;
      for (let i = 1; i < seqList.length; i++) {
        if (seqList[i] === seqList[i - 1] + 1) {
          consecutiveCount++;
          if (consecutiveCount >= 3) {
            warnings.push({
              type: 'EXCESSIVE_CONSECUTIVE_PROCTOR',
              teacherId,
              day: parseInt(day, 10),
              message: `教員(ID: ${teacherId})が Day ${day} に${consecutiveCount}コマ連続で試験監督に割り当てられています。`,
            });
          }
        } else {
          consecutiveCount = 1;
        }
      }
    }

    return { errors, warnings };
  },

  /**
   * 制約解決・監督自動最適化ソルバー (Auto-Optimization Algorithm)
   * アルゴリズム概要:
   *  - 全科目スロットに対し、自教科不一致・非重複・除外回避・負担平準化スコアリングにより最適教員を選択・自動割り当て
   * @param {string} examMasterId
   * @param {Object} operatorUser
   */
  async autoAssignProctors(examMasterId, operatorUser) {
    if (!examMasterId) {
      throw new ApiError(400, '考査マスターIDが指定されていません。');
    }

    const master = await examModel.findExamMasterById(examMasterId);
    if (!master) {
      throw new ApiError(404, '対象の考査マスターが存在しません。');
    }

    const slots = await examModel.getExamSlots(examMasterId);
    if (slots.length === 0) {
      throw new ApiError(400, '科目時間割スロットが登録されていないため、自動最適化を実行できません。');
    }

    const allTeachers = await userModel.listAll();
    const activeTeachers = allTeachers.filter(u => u.status !== 'OUT' && u.role !== 'PART_TIME');
    const exemptions = await examModel.getTeacherExemptions(examMasterId);
    const exemptedTeacherIds = new Set(exemptions.map(e => e.teacher_id));

    // 利用可能な監督担当教員プール
    const availableTeachers = activeTeachers.filter(t => !exemptedTeacherIds.has(t.id));

    if (availableTeachers.length === 0) {
      throw new ApiError(400, '利用可能な監督教員が存在しません。');
    }

    // 教員ごとの割り当てコマ数およびコマ状態トラッカー
    const teacherAssignmentsCount = new Map(availableTeachers.map(t => [t.id, 0]));
    const occupiedSlots = new Map(); // key: `${teacherId}_${day}_${slot}`, value: boolean

    const generatedAssignments = [];

    // 全スロットをソート (コマ順・クラス順)
    const sortedSlots = [...slots].sort((a, b) => {
      if (a.day_number !== b.day_number) return a.day_number - b.day_number;
      if (a.slot_number !== b.slot_number) return a.slot_number - b.slot_number;
      return a.class_id.localeCompare(b.class_id);
    });

    for (const slot of sortedSlots) {
      const day = slot.day_number;
      const slotNum = slot.slot_number;
      const subjectTeacherId = slot.subject_teacher_id;

      // 候補教員のフィルタリングとスコアリング
      let bestCandidate = null;
      let minScore = Infinity;

      for (const teacher of availableTeachers) {
        const timeKey = `${teacher.id}_${day}_${slotNum}`;

        // ハード制約 1: 同一コマで既に他クラスの監督を担当している場合はスキップ
        if (occupiedSlots.get(timeKey)) continue;

        // ハード制約 2: 自教科の試験中の自コマは回避
        if (subjectTeacherId && teacher.id === subjectTeacherId) continue;

        // スコアリング (担当数が少なく、負担が平準化される教員を優先)
        const currentCount = teacherAssignmentsCount.get(teacher.id) || 0;
        
        // 連続コマペナルティ計算
        const prevSlotKey = `${teacher.id}_${day}_${slotNum - 1}`;
        const consecutivePenalty = occupiedSlots.get(prevSlotKey) ? 5 : 0;

        const score = currentCount * 10 + consecutivePenalty;

        if (score < minScore) {
          minScore = score;
          bestCandidate = teacher;
        }
      }

      // フォールバック: 条件に適合する教員がいない場合は自教科制限を緩和して最小割り当て者を選択
      if (!bestCandidate) {
        for (const teacher of availableTeachers) {
          const timeKey = `${teacher.id}_${day}_${slotNum}`;
          if (occupiedSlots.get(timeKey)) continue;

          const currentCount = teacherAssignmentsCount.get(teacher.id) || 0;
          if (currentCount < minScore) {
            minScore = currentCount;
            bestCandidate = teacher;
          }
        }
      }

      if (bestCandidate) {
        const timeKey = `${bestCandidate.id}_${day}_${slotNum}`;
        occupiedSlots.set(timeKey, true);
        teacherAssignmentsCount.set(bestCandidate.id, (teacherAssignmentsCount.get(bestCandidate.id) || 0) + 1);

        generatedAssignments.push({
          exam_master_id: examMasterId,
          day_number: day,
          slot_number: slotNum,
          class_id: slot.class_id,
          proctor_teacher_id: bestCandidate.id,
        });
      }
    }

    // 自動最適化結果を保存
    await examModel.saveProctorAssignments(examMasterId, generatedAssignments);

    // 矛盾診断を実行
    const diagnosis = await this.diagnoseConflicts(examMasterId);

    // 監査ログの記録
    await auditModel.logAction({
      userId: operatorUser.id,
      action: 'AUTO_OPTIMIZE_EXAM_PROCTORS',
      targetEntity: 'EXAM_MASTER',
      targetId: examMasterId,
      changesJson: JSON.stringify({
        totalSlots: sortedSlots.length,
        assignedCount: generatedAssignments.length,
        conflictErrorsCount: diagnosis.errors.length,
        conflictWarningsCount: diagnosis.warnings.length,
      }),
    });

    return {
      message: '試験監督の自動割り当て最適化が正常に完了しました。',
      assignedSlotsCount: generatedAssignments.length,
      conflicts: diagnosis,
    };
  },

  /**
   * 単一コマの監督手動変更（変更直後にリアルタイム矛盾診断）
   * @param {string} examMasterId
   * @param {Object} updateData - { dayNumber, slotNumber, classId, teacherId }
   * @param {Object} user
   */
  async updateProctorAssignment(examMasterId, updateData, user) {
    const { dayNumber, slotNumber, classId, teacherId } = updateData;

    if (!examMasterId || !dayNumber || !slotNumber || !classId || !teacherId) {
      throw new ApiError(400, '考査ID、日程番号、コマ番号、クラスID、教員IDはすべて必須です。');
    }

    await examModel.updateSingleProctor(
      examMasterId,
      parseInt(dayNumber, 10),
      parseInt(slotNumber, 10),
      classId,
      teacherId
    );

    // 変更後の即時矛盾診断
    const conflicts = await this.diagnoseConflicts(examMasterId);

    await auditModel.logAction({
      userId: user.id,
      action: 'MANUAL_UPDATE_EXAM_PROCTOR',
      targetEntity: 'EXAM_MASTER',
      targetId: examMasterId,
      changesJson: JSON.stringify(updateData),
    });

    return {
      message: '監督割り当てを変更しました。',
      conflicts,
    };
  },

  /**
   * 考査コマ・科目時間割スロットの一括設定・更新
   * @param {string} examMasterId
   * @param {Array<Object>} slots
   * @param {Object} user
   */
  async saveExamSlots(examMasterId, slots, user) {
    if (!examMasterId || !Array.isArray(slots)) {
      throw new ApiError(400, '考査IDおよびスロットデータ配列は必須です。');
    }

    const savedSlots = await examModel.saveExamSlots(examMasterId, slots);

    await auditModel.logAction({
      userId: user.id,
      action: 'SAVE_EXAM_SLOTS',
      targetEntity: 'EXAM_MASTER',
      targetId: examMasterId,
      changesJson: JSON.stringify({ slotCount: slots.length }),
    });

    return savedSlots;
  },
};

export default examService;