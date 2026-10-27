import { ensureConfigFile, saveConfig, hashPassword, generatePassword } from './config.mjs';

ensureConfigFile();
const password = process.argv[2] || generatePassword(16);
saveConfig({ auth: { passwordHash: hashPassword(password), mustChange: false } });
console.log('管理员密码已重置为：');
console.log(password);
