import {randomBytes,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(derive);
export async function hashAdminPassword(password:string){
  const salt=randomBytes(16).toString('hex');
  const key=await scrypt(password,salt,64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyAdminPassword(password:string,encoded:string){
  const match=/^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded);
  if(!match)return false;
  const key=await scrypt(password,match[1],64) as Buffer;
  return timingSafeEqual(key,Buffer.from(match[2],'hex'));
}
