const p = require('@babel/parser');
const fs = require('fs');
const files = [
  'public/js/modules/facility.module.js',
  'src/models/facility.model.js',
  'src/services/facility.service.js',
  'src/controllers/facility.controller.js',
  'src/routes/index.js',
  'public/js/socket.js',
  'public/js/main.js',
  'public/js/config.js',
];
for (const f of files) {
  try {
    p.parse(fs.readFileSync(f, 'utf8'), { sourceType: 'module' });
    console.log('OK   ' + f);
  } catch (e) {
    console.log('FAIL ' + f + ' -> ' + e.message);
  }
}