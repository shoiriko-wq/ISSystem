import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const prooms = await examModel.listRoomAssignments('e2e-exam');
console.log('ROOMROWS', JSON.stringify(prooms.filter(r=>r.grade===2&&r.day_number===4).map(r=>[r.grade,r.day_number,r.slot_number,r.room_name,r.room_type])));
const rooms = await examModel.listRooms('e2e-exam');
console.log('ROOMS', JSON.stringify(rooms.map(r=>[r.name,r.room_type])));
await pool.end();
