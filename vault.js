// chrome-live "내 정보" vault: the owner's personal info for filling web forms.
// - Stored ONLY on this PC, encrypted at rest with Windows DPAPI (CurrentUser scope + app entropy) via a short
//   powershell.exe call (plaintext goes through stdin, never the command line). File: %LOCALAPPDATA%\chrome-live\vault.dat
// - Claude never receives values: it sees keys/labels/aliases (`cli.js vault`), asks the daemon to fill
//   (`cli.js fill <id> --map {"#css":"vault:key"}`) or writes `{{vault:key}}` inside string literals of a `run`
//   script. The daemon substitutes locally right before the worker types, and every result/error/log/event that
//   passes through the daemon is redacted (value -> [vault:key]).
// - 민감 items need a click in the side panel (confirmation card) before they are typed.
// - Refuses card numbers/CVC, full 주민등록번호, OTP/보안카드, and passwords EXCEPT in the owner-created category
//   "가입용 계정" (v9, owner decision 2026-10-31: one reusable signup password, 민감, filled only via fill/'{{vault:key}}').
// - v9: 주민등록번호 앞 7자리 (rrn7, e.g. 900101-1) is allowed for 휴대폰 본인인증.
// - v12 (owner decision 2026-10-31): 주민번호 뒷자리 7자리 (rrn_back) may be stored too (민감, digits only) so identity forms
//   (7-box / 7-digit back fields, 13-digit single fields, 6+7 splits) can be filled. EVERY fill that uses it shows the panel
//   confirmation card (ownerApproved never skips it). 13 digits in ONE item stay refused (front = rrn7, back = rrn_back);
//   derived fill keys: rrn_full (13 digits), rrn_front6, and <rrn key>#N (N-th digit, for 1-char boxes).
//   Secure virtual keypads (readonly / nProtect / TouchEn / transkey inputs) are never automated.
//   민감 confirm card can be skipped with ownerApproved=true ONLY while a side-panel chat (the owner's own request) runs.
// - v8: 메모 (notes: title + multi-line body per category; Claude sees titles only) and 한꺼번에 추가 (parse a pasted
//   "항목<TAB|2+ spaces>정보" block -> items + optional note; panel bulk-parse/bulk-save, CLI vault-import via STDIN).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_FILE = process.env.CHROME_LIVE_VAULT_FILE || path.join(process.env.LOCALAPPDATA || os.homedir(), 'chrome-live', 'vault.dat');   // env: isolated tests
const ENTROPY = 'chrome-live-vault-v1';
const SIGNUP_CAT = '가입용 계정';
const CATEGORIES = ['기본 정보', '연락처', '주소', '회사/사업자', '계좌', SIGNUP_CAT, '기타'];
const SENS = ['일반', '민감'];
const CONFIRM_MS = 120000;

// suggested items (panel "추천" chips). Matching uses each saved item's own aliases/ac (prefilled from these).
const TEMPLATES = [
  { key: 'name', label: '이름', cat: '기본 정보', aliases: ['이름', '성명', '성함', '신청자명', '주문자명', 'name', 'fullname', 'full name', 'your name'], ac: ['name'] },
  { key: 'name_en', label: '영문 이름', cat: '기본 정보', aliases: ['영문이름', '영문성명', '영문명', 'english name', 'name in english'], ac: [] },
  { key: 'birth', label: '생년월일', cat: '기본 정보', sens: '민감', aliases: ['생년월일', '생일', 'birth', 'birthday', 'birthdate', 'date of birth', 'dob'], ac: ['bday'] },
  { key: 'rrn7', label: '주민번호 앞 7자리', cat: '기본 정보', sens: '민감', aliases: ['주민번호 앞자리', '주민등록번호 앞 7자리', '주민번호 앞 7자리', '생년월일+성별 숫자'], ac: [] },
  { key: 'rrn_back', label: '주민번호 뒷자리', cat: '기본 정보', sens: '민감', aliases: ['주민번호 뒷자리', '주민등록번호 뒷자리', '주민번호 뒤 7자리', '주민등록번호 뒤 7자리', '주민번호 뒷 7자리'], ac: [] },
  { key: 'gender', label: '성별', cat: '기본 정보', aliases: ['성별', 'gender', 'sex'], ac: ['sex'] },
  { key: 'phone', label: '휴대폰', cat: '연락처', aliases: ['휴대폰', '휴대전화', '핸드폰', '휴대폰번호', '휴대전화번호', '전화번호', '연락처', 'phone', 'mobile', 'cellphone', 'tel', 'hp', 'cell', 'phone number', 'mobile number'], ac: ['tel', 'tel-national', 'mobile'] },
  { key: 'carrier', label: '통신사', cat: '연락처', aliases: ['통신사', '이동통신사', '휴대폰 통신사', '가입 통신사', 'carrier', 'telecom', 'mobile carrier'], ac: [] },
  { key: 'email', label: '이메일', cat: '연락처', aliases: ['이메일', '메일', '전자우편', 'email', 'e-mail', 'mail', 'email address'], ac: ['email'] },
  { key: 'postcode', label: '우편번호', cat: '주소', aliases: ['우편번호', 'zip', 'zipcode', 'postcode', 'postal', 'postal code', 'zip code'], ac: ['postal-code'] },
  { key: 'address1', label: '주소', cat: '주소', aliases: ['주소', '기본주소', '도로명주소', 'address', 'addr', 'addr1', 'address1', 'street', 'street address'], ac: ['address-line1', 'street-address'] },
  { key: 'address2', label: '상세주소', cat: '주소', aliases: ['상세주소', '나머지주소', '상세', 'addr2', 'address2', 'detail address', 'address line 2'], ac: ['address-line2'] },
  { key: 'company', label: '회사명', cat: '회사/사업자', aliases: ['회사명', '회사', '상호', '상호명', '업체명', '기업명', '법인명', 'company', 'company name', 'organization', 'org'], ac: ['organization'] },
  { key: 'dept', label: '부서', cat: '회사/사업자', aliases: ['부서', '부서명', 'department', 'dept'], ac: [] },
  { key: 'job_title', label: '직책', cat: '회사/사업자', aliases: ['직책', '직위', '직급', 'job title', 'position'], ac: ['organization-title'] },
  { key: 'biz_no', label: '사업자등록번호', cat: '회사/사업자', sens: '민감', aliases: ['사업자등록번호', '사업자번호', 'business number', 'business registration number', 'brn'], ac: [] },
  { key: 'ceo', label: '대표자', cat: '회사/사업자', aliases: ['대표자', '대표자명', '대표자성명', 'ceo', 'representative'], ac: [] },
  { key: 'office_tel', label: '회사 전화', cat: '회사/사업자', aliases: ['회사전화', '사무실전화', '대표번호', '유선전화', 'office phone', 'company phone', 'work phone'], ac: [] },
  { key: 'website', label: '홈페이지', cat: '회사/사업자', aliases: ['홈페이지', '웹사이트', 'website', 'homepage'], ac: ['url'] },
  { key: 'bank', label: '은행', cat: '계좌', aliases: ['은행', '은행명', '입금은행', 'bank', 'bank name'], ac: [] },
  { key: 'account_no', label: '계좌번호', cat: '계좌', sens: '민감', aliases: ['계좌번호', '계좌', '입금계좌', 'account number', 'account no', 'bank account'], ac: [] },
  { key: 'account_holder', label: '예금주', cat: '계좌', aliases: ['예금주', '예금주명', 'account holder', 'holder name'], ac: [] },
  { key: 'signup_id', label: '가입용 아이디', cat: SIGNUP_CAT, aliases: ['아이디', 'ID', 'username', 'user id', 'userid', 'login id', '회원 아이디'], ac: ['username'] },
  { key: 'signup_password', label: '가입용 비밀번호', cat: SIGNUP_CAT, sens: '민감', aliases: ['비밀번호', '비밀번호 확인', 'password', 'password confirm', 'confirm password', '비밀번호 재입력'], ac: ['new-password'] },
];

// ---------- never stored ----------
// FORBIDDEN_WORDS = everything we never fill/store by default (also used to block form fields).
// PW_WORDS are allowed only in the "가입용 계정" category (v9); RRN7_WORDS ("주민번호 앞 7자리") are stripped before the check.
const FORBIDDEN_WORDS = /(비밀\s*번호|비번|패스워드|암호|password|passwd|passcode|\bpw\b|\bpin\b|카드\s*번호|card\s*(number|no)|신용\s*카드|체크\s*카드|cvc|cvv|유효\s*기간|주민\s*(등록)?\s*번호|resident\s*(registration)?\s*number|\bssn\b|\botp\b|일회용|보안\s*카드|인증\s*번호|security\s*code|verification\s*code)/i;
const PW_WORDS = /(비밀\s*번호|비번|패스워드|암호|password|passwd|\bpw\b)/i;
const HARD_FORBIDDEN = /(passcode|\bpin\b|카드\s*번호|card\s*(number|no)|신용\s*카드|체크\s*카드|cvc|cvv|유효\s*기간|주민\s*(등록)?\s*번호|resident\s*(registration)?\s*number|\bssn\b|\botp\b|일회용|보안\s*카드|인증\s*번호|security\s*code|verification\s*code)/i;
const RRN7_RE = /주민\s*(?:등록)?\s*번호\s*(?:앞\s*(?:7|칠|일곱)?\s*자리|앞\s*부분)|생년월일\s*\+?\s*성별(?:\s*숫자)?|\brrn\s*7\b/i;
const stripRrn7 = s => String(s || '').replace(new RegExp(RRN7_RE.source, 'gi'), ' ');
const isRrn7Words = s => RRN7_RE.test(String(s || ''));
// v12: 주민번호 뒷자리 (7 digits) words; stripped like the RRN7 words before the forbidden check
const RRN_BACK_KEY = 'rrn_back';
const RRN_BACK_RE = /주민\s*(?:등록)?\s*번호\s*(?:뒷|뒤)\s*(?:(?:7|칠|일곱)\s*)?(?:자리|번호|부분|숫자)?|\brrn[\s_-]*back(?![a-z])/i;
const isRrnBackWords = s => RRN_BACK_RE.test(String(s || ''));
const stripRrn = s => stripRrn7(s).replace(new RegExp(RRN_BACK_RE.source, 'gi'), ' ');
const AUTO_SENSITIVE = /(생년월일|생일|birth|사업자|계좌\s*번호|account\s*(number|no)|여권|passport|운전\s*면허|driver'?s?\s*licen[cs]e|외국인\s*등록|법인\s*등록|비밀\s*번호|비번|패스워드|암호|password|passwd|\bpw\b|주민|\brrn)/i;
function luhn(d) { let s = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; }
const itemWords = it => [it.label, it.key, ...(it.aliases || [])].join(' ');
// 가입용 비밀번호 item (only possible in the 가입용 계정 category)
const isPasswordItem = it => !!it && it.cat === SIGNUP_CAT && PW_WORDS.test(stripRrn(itemWords(it)));
// 주민번호 뒷자리 item (v12): every fill that uses it needs the panel card
const isRrnBackItem = it => !!it && (it.key === RRN_BACK_KEY || isRrnBackWords(itemWords(it)));
function forbiddenReason(it) {
  const raw = itemWords(it);
  const words = stripRrn(raw);
  const pwOk = it.cat === SIGNUP_CAT;
  const w = words.match(HARD_FORBIDDEN) || (!pwOk && words.match(PW_WORDS));
  if (w) return PW_WORDS.test(w[0])
    ? `"${w[0]}" 같은 정보는 저장하지 않아요 (비밀번호는 "가입용 계정" 분류에서만 저장할 수 있어요. 카드·OTP는 저장 안 함)`
    : /주민|resident|ssn/i.test(w[0])
      ? `"${w[0]}" 같은 정보는 그대로 저장하지 않아요 (주민번호는 "주민번호 앞 7자리"와 "주민번호 뒷자리"(숫자 7자리) 두 항목으로 나눠 저장해요)`
      : `"${w[0]}" 같은 정보는 저장하지 않아요 (카드·CVC·유효기간·OTP·인증번호는 저장 안 함)`;
  const v = String(it.value || '');
  if (/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{3,4}\b/.test(v)) return '카드번호처럼 보이는 값은 저장하지 않아요';
  const digits = v.replace(/[\s-]/g, '');
  const isAccount = it.cat === '계좌' || /계좌|account/i.test(words);
  if (/^\d{15,16}$/.test(digits) && luhn(digits) && !isAccount) return '카드번호처럼 보이는 값은 저장하지 않아요 (계좌번호라면 분류를 "계좌"로)';
  const rrn = v.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})\s*(-?)\s*([1-8])\d{6}(?:\D|$)/);
  if (rrn) {
    const mo = +rrn[2], dd = +rrn[3];
    if (rrn[4] === '-' || (!isAccount && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31)) return '주민등록번호 전체(13자리)는 한 항목에 저장하지 않아요 ("주민번호 앞 7자리" 예: 900101-1 과 "주민번호 뒷자리" 숫자 7자리로 나눠 저장해요)';
  }
  if (isRrnBackItem(it)) {
    if (isRrn7Words(raw)) return '주민번호 앞 7자리와 뒷자리는 서로 다른 항목으로 저장해요';
    if (v.trim() && !/^[1-8]\d{6}$/.test(v.replace(/[\s-]/g, ''))) return '주민번호 뒷자리는 숫자 7자리(첫 숫자 1~8)만 저장해요';
    return null;
  }
  if ((isRrn7Words(raw) || it.key === 'rrn7') && v.trim() && !/^\d{6}\s*-?\s*[1-8]$/.test(v.trim()))
    return '주민번호 앞부분은 앞 7자리(생년월일 6자리 + 성별 숫자 1자리, 예: 900101-1)로 저장해요 (뒷자리 7자리는 "주민번호 뒷자리" 항목)';
  return null;
}

// ---------- validation ----------
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'k$1').slice(0, 40); }
function cleanStr(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n); }
function normalizeItem(raw, items, origKey) {
  const it = {
    key: cleanStr(raw.key, 40).toLowerCase(),
    label: cleanStr(raw.label, 40),
    value: String(raw.value == null ? '' : raw.value).replace(/\r\n?/g, '\n').slice(0, 500),
    cat: CATEGORIES.includes(raw.cat) ? raw.cat : '기타',
    aliases: [...new Set((Array.isArray(raw.aliases) ? raw.aliases : String(raw.aliases || '').split(/[,\n]/)).map(a => cleanStr(a, 40)).filter(Boolean))].slice(0, 30),
    sens: SENS.includes(raw.sens) ? raw.sens : '일반',
    ac: [...new Set((Array.isArray(raw.ac) ? raw.ac : String(raw.ac || '').split(/[,\s]+/)).map(a => cleanStr(a, 40).toLowerCase()).filter(a => /^[a-z0-9-]+$/.test(a)))].slice(0, 10),
    ...(raw.nofill === true ? { nofill: true } : {}),   // derived info (e.g. 나이): kept, but never proposed by match
  };
  if (!it.label) throw new Error('이름(라벨)을 입력하세요');
  if (!it.key) {
    const t = TEMPLATES.find(t => t.label === it.label);
    let base = (t && t.key) || slug(it.label) || 'item';
    let k = base, n = 2; while (items.some(x => x.key === k && x.key !== origKey)) k = `${base}_${n++}`;
    it.key = k;
  }
  if (!KEY_RE.test(it.key)) throw new Error('키는 영문 소문자로 시작하고 영문/숫자/_ 만 (예: phone, address1)');
  if (items.some(x => x.key === it.key && x.key !== origKey)) throw new Error(`키 "${it.key}"가 이미 있어요`);
  const bad = forbiddenReason(it);
  if (bad) throw new Error(bad);
  if (AUTO_SENSITIVE.test([it.label, it.key, ...it.aliases].join(' '))) it.sens = '민감';
  if (isPasswordItem(it)) it.sens = '민감';
  if (isRrnBackItem(it)) { it.sens = '민감'; it.value = it.value.replace(/[\s-]/g, ''); }
  // typo guard: 앞 7자리의 성별 숫자 == 뒷자리 첫 숫자 (no values in the message)
  const r7 = it.key === 'rrn7' ? it : isRrnBackItem(it) ? items.find(x => x.key === 'rrn7' && x.key !== origKey && x.value) : null;
  const rb = isRrnBackItem(it) ? it : it.key === 'rrn7' ? items.find(x => isRrnBackItem(x) && x.key !== origKey && x.value) : null;
  if (r7 && rb && r7.value && rb.value && r7.value.replace(/\D/g, '').slice(6, 7) !== rb.value.slice(0, 1))
    throw new Error('주민번호 뒷자리의 첫 숫자가 "주민번호 앞 7자리"의 마지막 숫자(성별)와 달라요. 다시 확인해 주세요');
  return it;
}
const emptyData = () => ({ v: 1, items: [], notes: [], updatedAt: null });

// ---------- 메모 (notes): free-text blocks (title + multi-line body) per category ----------
// Same file/encryption as items; bodies go only to the panel. Claude's `vault` listing shows titles only.
const NOTE_MAX = 20000, NOTES_MAX = 300;
const RRN_BACK_NOTE = '주민번호 뒷자리는 메모에 넣지 않아요 ("주민번호 뒷자리" 항목으로 저장하면 기입할 때마다 확인 카드가 떠요)';
function noteForbidden(n) {
  const t = forbiddenReason({ label: n.title, value: '', cat: n.cat });
  if (t) return t;
  for (const line of String(n.body || '').split('\n')) {
    const r = splitRow(line);
    if (r && isRrnBackWords(r.label)) return RRN_BACK_NOTE;
    const bad = r ? forbiddenReason({ label: r.label, value: r.value, cat: n.cat }) : forbiddenReason({ label: '', value: line, cat: n.cat });
    if (bad) return bad;
  }
  return null;
}
function cleanBody(b) {
  return String(b == null ? '' : b).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/^(\s*\n)+/, '').replace(/\s+$/, '').slice(0, NOTE_MAX);
}
function normalizeNote(raw, notes, origId) {
  const now = new Date().toISOString();
  const prev = origId ? notes.find(x => x.id === origId) : null;
  const n = { id: prev ? prev.id : crypto.randomBytes(6).toString('hex'), title: cleanStr(raw.title, 60),
    cat: CATEGORIES.includes(raw.cat) ? raw.cat : '기타', body: cleanBody(raw.body), createdAt: (prev && prev.createdAt) || now, updatedAt: now };
  if (!n.title) throw new Error('메모 제목을 입력하세요');
  if (!n.body.trim()) throw new Error('메모 내용이 비어 있어요');
  const bad = noteForbidden(n);
  if (bad) throw new Error(bad);
  return n;
}

// ---------- 한꺼번에 추가: parse a pasted block ("heading" line, optional "항목  정보" header, rows "label<TAB|2+ spaces>value") ----------
const HEADER_L = /^(항목|항목명|구분|분류|필드|field|item|key|name|label)$/i;
const HEADER_V = /^(정보|내용|값|상세|value|values|info|data|detail)$/i;
function splitRow(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^([^\t]+?)\t+([\s\S]*)$/))) return { label: m[1].trim(), value: m[2].replace(/\t+/g, ' ').trim() };
  if (t.startsWith('|')) {
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim());
    if (cells.length >= 2 && cells[0]) return { label: cells[0], value: cells.slice(1).filter(Boolean).join(' ') };
    return null;
  }
  if ((m = t.match(/^(\S.*?)(?: {2,}|　+)(\S.*)$/))) return { label: m[1].trim(), value: m[2].trim() };
  if ((m = t.match(/^([^:：]{1,20}?)\s*[:：]\s*(\S.*)$/)) && !/\d$/.test(m[1]) && !/^https?$/i.test(m[1].trim())) return { label: m[1].trim(), value: m[2].trim() };
  return null;
}
const isHeaderRow = r => HEADER_L.test(r.label) && HEADER_V.test(r.value);
const isTableRule = t => /^[\s|:\-–—=]+$/.test(t) && /-{2,}|={2,}/.test(t);
function parseBlock(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  let heading = null, headingLine = -1, headerSkipped = false;
  const rows = [], unparsed = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || isTableRule(t)) return;
    const r = splitRow(t);
    if (!r || !r.label) {
      if (heading == null && !rows.length) { heading = cleanStr(t.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1'), 60); headingLine = i; }
      else unparsed.push({ line: i, text: t.slice(0, 120) });
      return;
    }
    if (!rows.length && isHeaderRow(r)) { headerSkipped = true; return; }
    rows.push({ line: i, label: cleanStr(r.label, 40), value: r.value.slice(0, 500) });
  });
  return { heading, headingLine, headerSkipped, rows, unparsed, lines };
}
// label -> suggested key/aliases/category (order matters: specific before generic)
const HINTS = [
  [/주민\s*(등록)?\s*번호\s*(뒷|뒤)|rrn[\s_-]*back/i, { tpl: 'rrn_back' }],
  [/주민\s*(등록)?\s*번호\s*앞|생년월일\s*\+?\s*성별/, { tpl: 'rrn7' }],
  [/통신사|carrier|telecom/i, { tpl: 'carrier' }],
  [/아이디|^id$|user\s*name|user\s*id|login\s*id/i, { tpl: 'signup_id', onlyCat: SIGNUP_CAT }],
  [/비밀\s*번호|패스워드|password/i, { tpl: 'signup_password', onlyCat: SIGNUP_CAT }],
  [/세는\s*나이|한국\s*(식\s*)?나이/, { key: 'age_kr', nofill: true }],
  [/나이|연령|^age$/i, { key: 'age', nofill: true }],
  [/영문\s*(회사|상호|법인|기업|업체)|english\s*company/i, { key: 'company_en', cat: '회사/사업자', aliases: ['영문 회사명', '영문 상호', '영문 법인명', '영문 회사', 'english company name', 'company name in english'] }],
  [/영문\s*(이름|성명|명)|english\s*name/i, { tpl: 'name_en' }],
  [/(회사|사무실|직장|업무|대표)\s*(전화|연락처|번호)|office\s*(phone|tel)|company\s*(phone|tel)|work\s*phone/i, { key: 'company_phone', cat: '회사/사업자', aliases: ['회사 전화번호', '회사 전화', '회사 연락처', '사무실 전화', '대표번호', '대표 전화', 'company phone', 'office phone', 'work phone'] }],
  [/(공용|대표|문의|공식)\s*(이메일|메일)|contact\s*e-?mail|general\s*e-?mail/i, { key: 'company_email_public', cat: '회사/사업자', aliases: ['공용 이메일', '대표 이메일', '문의 이메일', 'contact email', 'general email'] }],
  [/(회사|업무|직장|비즈니스)\s*(이메일|메일)|work\s*e-?mail|company\s*e-?mail|business\s*e-?mail/i, { key: 'company_email', cat: '회사/사업자', aliases: ['회사 이메일', '업무 이메일', '회사 메일', 'company email', 'work email', 'business email'] }],
  [/(다른|보조|기존|추가|두\s*번째|서브|예비).*(이메일|메일)|alt(ernate)?\s*e-?mail|secondary\s*e-?mail/i, { key: 'email_alt', cat: '연락처', aliases: ['보조 이메일', '다른 이메일', '추가 이메일', 'secondary email', 'alternate email'] }],
  [/이메일|메일|e-?mail/i, { tpl: 'email' }],
  [/출생\s*(시간|시각)|태어난\s*시간|birth\s*time|time\s*of\s*birth/i, { key: 'birth_time', cat: '기본 정보', sens: '민감', aliases: ['출생시간', '출생 시각', '태어난 시간', 'birth time', 'time of birth'] }],
  [/생년월일|생일|birth|dob/i, { key: 'birth_date', tpl: 'birth' }],
  [/성별|gender|^sex$/i, { tpl: 'gender' }],
  [/(사업|회사)?\s*브랜드|brand/i, { key: 'brand', cat: '회사/사업자', aliases: ['브랜드', '브랜드명', '사업 브랜드', 'brand', 'brand name'] }],
  [/주요\s*사업|업종|업태|사업\s*(분야|내용|종류|영역)|business\s*type|industry/i, { key: 'business_type', cat: '회사/사업자', aliases: ['업종', '업태', '주요 사업', '사업 분야', '사업 내용', 'business type', 'industry'] }],
  [/사업자\s*(등록)?\s*번호/, { tpl: 'biz_no' }],
  [/전화|휴대|핸드폰|연락처|mobile|phone|^tel$/i, { tpl: 'phone' }],
  [/회사명|^회사$|상호|법인명|기업명|업체명|company/i, { tpl: 'company' }],
  [/직책|직위|직급|position|job\s*title/i, { tpl: 'job_title' }],
  [/대표자/, { tpl: 'ceo' }],
  [/^(이름|성명|성함|name|full\s*name)$/i, { tpl: 'name' }],
];
function suggestFor(label, blockCat) {
  let h = null;
  for (const [re, x] of HINTS) if (re.test(label) && (!x.onlyCat || x.onlyCat === blockCat)) { h = x; break; }
  const tpl = h ? (h.tpl ? TEMPLATES.find(t => t.key === h.tpl) : null) : TEMPLATES.find(t => t.label === label);
  const key = (h && h.key) || (tpl && tpl.key) || slug(label) || '';
  const aliases = h && h.nofill ? [] : [...new Set([label, ...((h && h.aliases) || (tpl && tpl.aliases) || [])])];
  return { key, aliases, ac: h && h.nofill ? [] : [...((tpl && tpl.ac) || [])], cat: (h && h.cat) || (tpl && tpl.cat) || (CATEGORIES.includes(blockCat) ? blockCat : '기타'),
    sens: (h && h.sens) || (tpl && tpl.sens) || '일반', ...(h && h.nofill ? { nofill: true } : {}) };
}
// preview rows (with values: panel only) + status vs. the existing vault
function previewRows(parsed, blockCat, items) {
  const used = new Set();
  return parsed.rows.map(r => {
    const row = { line: r.line, label: r.label, value: r.value, ...suggestFor(r.label, blockCat) };
    if (AUTO_SENSITIVE.test([row.label, row.key, ...row.aliases].join(' '))) row.sens = '민감';
    const bad = forbiddenReason(row);
    if (bad) return { ...row, value: '', status: 'skip', reason: bad };
    if (!row.value) return { ...row, status: 'skip', reason: '값이 비어 있어요' };
    if (row.key && used.has(row.key)) { let n = 2; while (used.has(`${row.key}_${n}`) || items.some(i => i.key === `${row.key}_${n}`)) n++; row.key = `${row.key}_${n}`; }
    if (row.key) used.add(row.key);
    const ex = row.key && items.find(i => i.key === row.key);
    row.status = !ex ? 'new' : !ex.value ? 'fill' : ex.value === row.value ? 'same' : 'conflict';
    return row;
  });
}
// note body = the pasted block minus the heading line and minus refused rows (line breaks / tabs kept)
function noteBodyFrom(parsed, cat) {
  let dropped = 0;
  const out = parsed.lines.filter((l, i) => {
    if (i === parsed.headingLine) return false;
    const r = splitRow(l);
    const bad = r ? (isRrnBackWords(r.label) ? RRN_BACK_NOTE : forbiddenReason({ label: r.label, value: r.value, cat })) : forbiddenReason({ label: '', value: l, cat });
    if (bad) { dropped++; return false; }
    return true;
  });
  return { body: cleanBody(out.join('\n')), dropped };
}
// apply rows to data d (mutates). Existing key: fill only if its value is empty; otherwise keep it and report a conflict.
function applyBulk(d, rows, note) {
  if (!Array.isArray(d.notes)) d.notes = [];
  const res = { added: [], filled: [], same: [], conflicts: [], skipped: [], note: null };
  const batch = new Set();
  for (const r of (rows || []).slice(0, 200)) {
    const label = cleanStr(r.label, 40);
    if (r.include === false) { res.skipped.push({ label, reason: '선택 안 함' }); continue; }
    const value = String(r.value == null ? '' : r.value).replace(/\r\n?/g, '\n').slice(0, 500);
    const key = cleanStr(r.key, 40).toLowerCase();
    const raw = { key, label, value, cat: r.cat, aliases: r.aliases, ac: r.ac, sens: r.sens, nofill: r.nofill === true };
    const bad = forbiddenReason(raw);
    if (bad) { res.skipped.push({ label, reason: bad }); continue; }
    if (!value.trim()) { res.skipped.push({ label, reason: '값이 비어 있어요' }); continue; }
    const ex = key && !batch.has(key) && d.items.find(i => i.key === key);
    if (ex) {
      if (!ex.value) { ex.value = value; res.filled.push(key); }
      else if (ex.value === value) res.same.push(key);
      else res.conflicts.push(key);
      continue;
    }
    if (key && batch.has(key)) { let n = 2; while (d.items.some(i => i.key === `${key}_${n}`)) n++; raw.key = `${key}_${n}`; }
    try { const it = normalizeItem(raw, d.items); d.items.push(it); batch.add(it.key); res.added.push(it.key); }
    catch (e) { res.skipped.push({ label, reason: e.message }); }
  }
  if (note && note.title && String(note.body || '').trim()) {
    const t0 = cleanStr(note.title, 60), cat = CATEGORIES.includes(note.cat) ? note.cat : '기타';
    if (d.notes.length >= NOTES_MAX) res.note = { title: t0, status: 'skip', reason: '메모가 너무 많아요' };
    else {
      const same = d.notes.find(n => n.title === t0 && n.cat === cat);
      if (same && same.body === cleanBody(note.body)) res.note = { title: same.title, status: 'same', id: same.id };
      else {
        let title = t0, k = 2;
        while (d.notes.some(n => n.title === title && n.cat === cat)) title = `${cleanStr(note.title, 54)} (${k++})`;
        try { const n = normalizeNote({ title, body: note.body, cat }, d.notes); d.notes.push(n); res.note = { title: n.title, status: 'added', id: n.id, lines: n.body.split('\n').length }; }
        catch (e) { res.note = { title, status: 'skip', reason: e.message }; }
      }
    }
  }
  return res;
}
// redaction material from notes: each row's value, or the whole line for free text (title and "항목 정보" header excluded)
function noteRedactItems(notes) {
  const out = [];
  for (const n of notes || []) for (const line of String(n.body || '').split('\n')) {
    const t = line.trim(); if (!t || t === n.title || isTableRule(t)) continue;
    const r = splitRow(t);
    if (r && isHeaderRow(r)) continue;
    if (r && r.value) out.push({ key: 'note', value: r.value });
    out.push({ key: 'note', value: t });
  }
  return out;
}


// ---------- DPAPI (CurrentUser) via powershell.exe; data passes through stdin as base64 ----------
function dpapi(op, buf) {
  if (op !== 'Protect' && op !== 'Unprotect') throw new Error('bad op');
  const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
    `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); ` +
    `$o=[Security.Cryptography.ProtectedData]::${op}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve, reject) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    let out = '', err = '';
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err = (err + d).slice(-400); });
    const t = setTimeout(() => { c.kill(); reject(new Error(`DPAPI ${op} timed out`)); }, 30000);
    c.on('error', e => { clearTimeout(t); reject(new Error(`DPAPI ${op}: ${e.message}`)); });
    c.on('close', code => {
      clearTimeout(t);
      if (code !== 0 || !out.trim()) return reject(new Error(`DPAPI ${op} failed (${code}): ${err.replace(/\s+/g, ' ').slice(0, 160)}`));
      resolve(Buffer.from(out.trim(), 'base64'));
    });
    c.stdin.end(buf.toString('base64'));
  });
}

// ---------- file store (one cache per file path) ----------
const CACHE = new Map();   // file -> { mtimeMs, data }
async function loadFile(file = DEFAULT_FILE) {
  let st; try { st = fs.statSync(file); } catch { CACHE.set(file, { mtimeMs: 0, data: emptyData() }); return CACHE.get(file).data; }
  const c = CACHE.get(file);
  if (c && c.mtimeMs === st.mtimeMs) return c.data;
  const wrap = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (wrap.format !== 'chrome-live-vault' || wrap.enc !== 'dpapi-currentuser') throw new Error('vault file has an unknown format');
  const data = JSON.parse((await dpapi('Unprotect', Buffer.from(wrap.data, 'base64'))).toString('utf8'));
  if (!Array.isArray(data.items)) data.items = [];
  if (!Array.isArray(data.notes)) data.notes = [];
  CACHE.set(file, { mtimeMs: st.mtimeMs, data });
  return data;
}
async function saveFile(data, file = DEFAULT_FILE) {
  data.updatedAt = new Date().toISOString();
  const enc = await dpapi('Protect', Buffer.from(JSON.stringify(data), 'utf8'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ format: 'chrome-live-vault', v: 1, enc: 'dpapi-currentuser', data: enc.toString('base64') }));
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.prev'); } catch {}   // previous version, also encrypted
  fs.renameSync(tmp, file);
  CACHE.set(file, { mtimeMs: fs.statSync(file).mtimeMs, data });
  return data;
}

// ---------- placeholders in run scripts: '{{vault:key}}' inside a string literal ----------
const PH_RE = /\{\{\s*vault:([a-z][a-z0-9_]*(?:#\d{1,2})?)\s*\}\}/gi;
const jsEscape = v => JSON.stringify(String(v)).slice(1, -1).replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\$/g, '\\$');
function placeholderKeys(code) { return [...new Set([...String(code).matchAll(PH_RE)].map(m => m[1].toLowerCase()))]; }
// keys may be derived (rrn_full, rrn_front6, <주민번호 key>#N); `used` = the stored items behind them (for the 민감 card)
function substitute(code, items) {
  const keys = placeholderKeys(code);
  const res = new Map(keys.map(k => [k, resolveKey(k, items)]));
  const missing = [...new Set(keys.flatMap(k => { const r = res.get(k); return !r ? [k] : r.missing || []; }))];
  if (missing.length) throw new Error(`내 정보에 없는(또는 값이 빈) 키: ${missing.join(', ')}. \`cli.js vault\`로 키를 확인하거나 owner에게 사이드 패널 "내 정보" 탭에 추가해 달라고 하세요`);
  const used = [...new Set(keys.flatMap(k => res.get(k).used))];
  return { code: String(code).replace(PH_RE, (_, k) => jsEscape(res.get(k.toLowerCase()).value)), keys, used,
    subs: keys.map(k => ({ key: k, value: String(res.get(k).value) })) };   // daemon-only: masks these in the 기록 "넣은 값" (never forwarded)
}

// ---------- redaction: any value (and digits-only / no-space variants) -> [vault:key] ----------
function makeRedactor(items) {
  const pairs = [];
  for (const it of items) {
    const v = String(it.value || '').trim();
    if (!v) continue;
    const vars = new Set();
    if (v.length >= 3 || (v.length >= 2 && /[^\x00-\x7f]/.test(v))) vars.add(v);
    const d = v.replace(/\D/g, ''); if (d.length >= 6) vars.add(d);
    if (/^\d{6}\s*-?\s*[1-8]$/.test(v)) vars.add(d.slice(0, 6));   // rrn7: the birth part alone
    const ns = v.replace(/\s+/g, ''); if (ns.length >= 3) vars.add(ns);
    for (const line of v.split('\n')) if (line.trim().length >= 4) vars.add(line.trim());
    for (const x of vars) pairs.push([x, `[vault:${it.key}]`]);
  }
  // v12: the whole 주민번호 (rrn7 front 6 + rrn_back), with/without hyphen or spaces -> one tag (longer than either part, so it wins)
  for (const r7 of items.filter(i => i.key === 'rrn7' && i.value)) for (const rb of items.filter(i => isRrnBackItem(i) && i.value)) {
    const f6 = String(r7.value).replace(/\D/g, '').slice(0, 6), b7 = String(rb.value).replace(/\D/g, '');
    if (f6.length !== 6 || b7.length !== 7) continue;
    for (const x of [`${f6}-${b7}`, `${f6}${b7}`, `${f6} - ${b7}`, `${f6} ${b7}`, `${f6}- ${b7}`, `${f6} -${b7}`]) pairs.push([x, '[vault:rrn_full]']);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return s => s;
  const re = new RegExp(pairs.map(p => p[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const map = new Map(pairs);
  return s => typeof s === 'string' ? s.replace(re, m => map.get(m) || '[vault]') : s;
}
// chat prompt / thread text the OWNER typed: 주민번호 parts (stored rrn7 / rrn_back) and any 13-digit 주민번호 shape are
// always replaced before Claude sees them (other 내 정보 values the owner types stay as they are)
const RRN_SHAPE = /(?<!\d)\d{2}(\d{2})(\d{2})\s*-?\s*[1-8]\d{6}(?!\d)/g;
function makePromptRedactor(items) {
  const red = makeRedactor((items || []).filter(i => i.key === 'rrn7' || isRrnBackItem(i)));
  return s => typeof s !== 'string' ? s
    : red(s).replace(RRN_SHAPE, (m, mo, dd) => (/-/.test(m) || (+mo >= 1 && +mo <= 12 && +dd >= 1 && +dd <= 31)) ? '[주민번호 가림]' : m);
}
function redactDeep(obj, red) {
  if (typeof obj === 'string') return red(obj);
  if (Array.isArray(obj)) return obj.map(x => redactDeep(x, red));
  if (obj && typeof obj === 'object') { const o = {}; for (const [k, v] of Object.entries(obj)) o[k] = redactDeep(v, red); return o; }
  return obj;
}

// ---------- form matching ----------
const norm = s => String(s || '').toLowerCase().replace(/\(?필수\)?|\(?선택\)?|required|optional/g, '').replace(/[\s*:：()[\]{}·.,/\\\-_'"!?※•]+/g, '');
const tokens = s => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
function fieldDesc(f) {
  const t = f.label || f.aria || f.context || f.placeholder || f.name || f.idAttr || f.selector;
  return `${String(t).slice(0, 40)}${f.type && f.type !== 'text' ? ' (' + f.type + ')' : ''}`;
}
function scoreItem(f, it) {
  let best = 0, why = '';
  const acTokens = String(f.autocomplete || '').toLowerCase().split(/\s+/).filter(t => t && !/^(section-|shipping|billing|home|work|on|off)/.test(t));
  const acs = it.ac || [];
  if (acTokens.some(t => acs.includes(t))) { best = 100; why = 'autocomplete'; }
  const aliases = [...new Set([it.label, it.key.replace(/_/g, ' '), ...(it.aliases || [])].map(a => String(a)).filter(Boolean))];
  const texts = [['label', f.label, 0], ['aria', f.aria, 0], ['context', f.context, -4], ['placeholder', f.placeholder, -6], ['title', f.title, -6]];
  for (const [src, raw, adj] of texts) {
    const t = norm(raw); if (!t) continue;
    for (const a of aliases) {
      const na = norm(a); if (na.length < 2) continue;
      let s = 0;
      if (t === na) s = 90 + adj;
      else if (t.includes(na) && !(na.length < 3 && /^[a-z0-9]+$/.test(na))) s = Math.min(85, 50 + na.length * 2) + adj;   // short ascii (ID, hp): exact only
      if (s > best) { best = s; why = `${src}~${a}`; }
    }
  }
  for (const [src, raw] of [['name', f.name], ['id', f.idAttr]]) {
    const tk = tokens(raw); if (!tk.length) continue;
    const joined = tk.join('');
    for (const a of aliases) {
      const at = tokens(a); if (!at.length || /[^\x00-\x7f]/.test(a)) continue;
      const aj = at.join(''); if (aj.length < 2) continue;
      let s = 0;
      if (joined === aj) s = 80;
      else { for (let i = 0; i + at.length <= tk.length; i++) if (at.every((x, j) => tk[i + j] === x)) { s = Math.min(78, 50 + aj.length); break; } }
      if (s > best) { best = s; why = `${src}~${a}`; }
    }
  }
  return { score: best, why };
}
// ---------- v12: 주민번호 field layouts (13-digit single, 6 + 7 split, 7-digit back, 1-char boxes) ----------
// Each consecutive run of 주민번호-looking fields is laid over the 13 digits (0-5 front, 6-12 back) and mapped to
// derived keys: rrn_full, rrn_front6, rrn_back, rrn_front6#N / rrn_back#N (N-th digit). "주민번호 앞 7자리" fields keep rrn7.
const RRN_TEXT_RE = /주민\s*(?:등록)?\s*번호|resident\s*(?:registration)?\s*(?:number|no)/i;
const RRN_TOKEN_RE = /^(?:jumin\w*|rrn\d*|ssn\d*|resno\d*|juminno\d*)$/;
const rrnTextOf = f => [f.label, f.aria, f.context, f.placeholder, f.title,
  (f.maxlength === 1 || !(f.label || f.aria || f.context || f.placeholder || f.title)) ? f.near : ''].join(' ');
const rrnTokens = f => [...tokens(f.name), ...tokens(f.idAttr)];
function rrnish(f) {
  if (SKIP_TYPES.has(f.type) || ['select', 'textarea', 'contenteditable'].includes(f.type)) return false;
  const t = rrnTextOf(f);
  if (!(RRN_TEXT_RE.test(t) || rrnTokens(f).some(x => RRN_TOKEN_RE.test(x) || x === 'resident'))) return false;
  if (isRrn7Words(t) && f.maxlength !== 6) return false;   // "주민번호 앞 7자리" -> the rrn7 item (scored as before)
  if (HARD_FORBIDDEN.test(stripRrn(t).replace(new RegExp(RRN_TEXT_RE.source, 'gi'), ' ')) || /cc-(number|csc|exp)|one-time-code/.test(String(f.autocomplete || ''))) return false;
  return true;
}
function rrnPart(f) {
  const t = rrnTextOf(f);
  if (isRrnBackWords(t) || /뒷\s*(?:자리|번호)|뒤\s*(?:7|칠|일곱)?\s*자리/.test(t)) return 'back';
  if (isRrn7Words(t) || /앞\s*(?:6|육|여섯)?\s*자리|생년월일/.test(t)) return 'front';
  const tk = rrnTokens(f).join(' ');
  if (/\b(?:back|last|second)\b|(?:jumin|rrn|ssn|resno)\w*2\b|\b2\b/.test(tk)) return 'back';
  if (/\b(?:front|first)\b|(?:jumin|rrn|ssn|resno)\w*1\b|\b1\b/.test(tk)) return 'front';
  return null;
}
function rrnPlan(fields) {
  const plan = new Map();   // field index -> { key } | { error }
  for (let i = 0; i < fields.length;) {
    if (!rrnish(fields[i])) { i++; continue; }
    const g = []; while (i < fields.length && rrnish(fields[i])) g.push(i++);
    const boxes = g.filter(j => fields[j].maxlength === 1).length;
    let pos = null;
    for (const j of g) {
      const f = fields[j], part = rrnPart(f), ml = f.maxlength || 0;
      const cap = ml === 1 ? 1 : (part === 'back' || ml === 7) ? 7 : (part === 'front' || ml === 6) ? 6 : ml >= 13 ? 13 : g.length === 1 ? 13 : (pos == null || pos === 0) ? 6 : 7;
      if (pos == null) pos = (part === 'back' || cap === 7 || (ml === 1 && boxes === 7 && g.length === 7)) ? 6 : 0;
      if (part === 'back' && pos < 6) pos = 6;
      if (pos + cap > 13) pos = (part === 'back' || cap === 7) ? 6 : 0;   // next 주민번호 widget right after the previous one
      let key = null;
      if (part === 'front' && pos >= 6) key = null;
      else if (cap === 13 && pos === 0) key = 'rrn_full';
      else if (cap === 6 && pos === 0) key = 'rrn_front6';
      else if (cap === 7 && pos === 6) key = RRN_BACK_KEY;
      else if (cap === 1 && pos < 13) key = pos < 6 ? `rrn_front6#${pos + 1}` : `${RRN_BACK_KEY}#${pos - 5}`;
      plan.set(j, key ? { key } : { error: '주민번호 칸 배치를 알 수 없음' });
      pos += cap;
    }
  }
  return plan;
}
// derived / digit keys: "rrn_full", "rrn_front6", "<key>#N" -> { value, base items, label } (null = unknown key)
const RRN_KEYS = new Set(['rrn7', 'rrn_front6', RRN_BACK_KEY, 'rrn_full']);
function resolveKey(key, items) {
  const m = String(key).match(/^([a-z][a-z0-9_]*)(?:#(\d{1,2}))?$/);
  if (!m) return null;
  const [, base, nth] = m;
  const byKey = new Map(items.map(i => [i.key, i]));
  const r7 = byKey.get('rrn7'), rb = byKey.get(RRN_BACK_KEY) || items.find(isRrnBackItem);
  let value, used, label;
  if (base === 'rrn_full') {
    used = [r7, rb]; label = '주민등록번호 13자리 (앞 7자리 + 뒷자리)';
    if (r7 && rb && r7.value && rb.value) value = String(r7.value).replace(/\D/g, '').slice(0, 6) + String(rb.value).replace(/\D/g, '');
  } else if (base === 'rrn_front6') {
    used = [r7]; label = '주민번호 앞 6자리 (생년월일)';
    if (r7 && r7.value) value = String(r7.value).replace(/\D/g, '').slice(0, 6);
  } else {
    const it = byKey.get(base); if (!it) return { missing: [base] };
    used = [it]; label = it.label; value = it.value || undefined;
  }
  const missing = [];
  if (base === 'rrn_full' || base === 'rrn_front6') { if (!r7 || !r7.value) missing.push('rrn7'); if (base === 'rrn_full' && (!rb || !rb.value)) missing.push(RRN_BACK_KEY); }
  else if (!value) missing.push(base);
  if (missing.length) return { missing };
  if (nth) {
    if (!RRN_KEYS.has(base) && !isRrnBackItem(used[0])) return null;   // digit picking only for 주민번호 keys
    const d = String(value).replace(/\D/g, ''), n = +nth;
    if (n < 1 || n > d.length) return null;
    value = d[n - 1]; label = `${label} ${n}번째 숫자`;
  }
  return { value, used: used.filter(Boolean), label, rrn: RRN_KEYS.has(base) && base !== 'rrn7' || used.some(isRrnBackItem) };
}
const KEYPAD_MSG = '보안 키패드(화면 키패드) 칸이라 자동으로 입력하지 않아요. owner가 화면 키패드로 직접 입력해야 해요';
function matchFields(fields, items) {
  const usable = items.filter(i => i.value && !i.nofill);
  const pwItems = usable.filter(isPasswordItem);
  const normal = usable.filter(i => !isPasswordItem(i) && !isRrnBackItem(i));   // rrn_back only through the 주민번호 layout below
  const proposals = [], unmatched = [], blocked = [], skipped = [], keypad = [], rrnMissing = new Set();
  const plan = rrnPlan(fields);
  for (const [fi, f] of fields.entries()) {
    if (SKIP_TYPES.has(f.type)) { skipped.push(fieldDesc(f)); continue; }
    if (f.keypad) { keypad.push(fieldDesc(f)); continue; }   // secure virtual keypad: never automated
    const rp = plan.get(fi);
    if (rp) {
      if (rp.error) { blocked.push(`${fieldDesc(f)} (${rp.error})`); continue; }
      const r = resolveKey(rp.key, usable);
      if (!r || r.missing) { for (const k of (r && r.missing) || []) rrnMissing.add(k); blocked.push(`${fieldDesc(f)} (내 정보에 ${((r && r.missing) || [rp.key]).join(', ')} 없음)`); continue; }
      if (f.readonly) { keypad.push(fieldDesc(f)); continue; }   // readonly 주민번호 칸 = bound to an on-screen keypad
      const always = r.used.some(isRrnBackItem);
      proposals.push({ selector: f.selector, field: fieldDesc(f), key: rp.key, label: r.label, sens: '민감', score: 95, why: '주민번호 칸 배치',
        ...(always ? { alwaysConfirm: true } : {}), ...(f.filled ? { alreadyFilled: true } : {}), ...(f.maxlength > 0 ? { maxlength: f.maxlength } : {}) });
      continue;
    }
    const text = stripRrn7([f.label, f.aria, f.context, f.placeholder, f.name, f.idAttr, f.autocomplete].join(' '));
    const ac = String(f.autocomplete || '');
    if (HARD_FORBIDDEN.test(text) || /cc-(number|csc|exp)|one-time-code/.test(ac)) { blocked.push(fieldDesc(f)); continue; }
    // password / password-confirm fields: only the 가입용 계정 password item (if the owner saved one)
    if (f.type === 'password' || PW_WORDS.test(text) || /current-password|new-password/.test(ac)) {
      if (!pwItems.length) { blocked.push(fieldDesc(f)); continue; }
      let bp = null; for (const it of pwItems) { const r = scoreItem(f, it); if (!bp || r.score > bp.score) bp = { ...r, it }; }
      const it = bp.it;
      proposals.push({ selector: f.selector, field: fieldDesc(f), key: it.key, label: it.label, sens: it.sens, score: Math.max(bp.score, 90), why: bp.why || 'password field',
        password: true, ...(f.readonly ? { readonly: true } : {}), ...(f.filled ? { alreadyFilled: true } : {}) });
      continue;
    }
    let best = null;
    for (const it of normal) {
      const r = scoreItem(f, it);
      if (r.score >= 50 && (!best || r.score > best.score)) best = { ...r, it };
    }
    if (!best) { unmatched.push(fieldDesc(f)); continue; }
    proposals.push({ selector: f.selector, field: fieldDesc(f), key: best.it.key, label: best.it.label, sens: best.it.sens, score: best.score, why: best.why,
      ...(f.readonly ? { readonly: true } : {}), ...(f.filled ? { alreadyFilled: true } : {}), ...(f.maxlength > 0 ? { maxlength: f.maxlength } : {}) });
  }
  const map = {}; for (const p of proposals) if (!p.readonly) map[p.selector] = `vault:${p.key}`;
  return { proposals, unmatched, blocked, skipped, map, keypad, rrnMissing: [...rrnMissing] };
}

// ---------- daemon glue ----------
function initVault({ log, addEvent, getTabMeta, canSkipConfirm, file = DEFAULT_FILE }) {
  const PENDING = new Map();   // id -> { info, resolve, expiresAt }
  const TRASH = new Map();     // undo id -> { kind:'item'|'note', obj, index, at } (daemon memory only, 2 min)
  function toTrash(kind, obj, index) {
    const now = Date.now(); for (const [k, v] of TRASH) if (now - v.at > 120000) TRASH.delete(k);
    const id = crypto.randomBytes(6).toString('hex'); TRASH.set(id, { kind, obj, index, at: now }); return id;
  }
  let redactor = s => s, promptRedactor = makePromptRedactor([]);
  const extraFiles = new Set();
  async function refreshRedactor() {
    const all = [];
    for (const f of [file, ...extraFiles]) { try { const d = await loadFile(f); all.push(...d.items, ...noteRedactItems(d.notes)); } catch {} }
    redactor = makeRedactor(all);
    promptRedactor = makePromptRedactor(all);
  }
  // warm the cache (one powershell call) so redaction is active before the first snapshot
  if (fs.existsSync(file)) refreshRedactor().catch(e => log(`vault load failed: ${e.message}`));

  // only real vault, or a TEST vault in the OS temp folder named chrome-live-test-vault*.dat (for automated tests)
  function vaultFileFor(args) {
    if (!args || !args.testVault) return file;
    const p = path.resolve(String(args.testVault));
    if (path.dirname(p).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !/^chrome-live-test-vault[\w-]*\.dat$/i.test(path.basename(p)))
      throw new Error('testVault must be %TEMP%\\chrome-live-test-vault*.dat');
    return p;
  }
  async function itemsFor(args) {
    const f = vaultFileFor(args);
    const d = await loadFile(f);
    if (f !== file && !extraFiles.has(f)) { extraFiles.add(f); await refreshRedactor(); }
    return d.items;
  }

  function askConfirm(info) {
    const id = crypto.randomBytes(6).toString('hex');
    addEvent({ cmd: 'vault', ok: true, id: info.tabId, host: info.host, title: info.title, label: `민감 정보 입력 확인 요청 · ${info.items.map(i => i.label).join(', ')}`.slice(0, 80) });
    log(`vault: confirmation requested (${info.items.map(i => i.key).join(',')}) tab ${info.tabId}`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { PENDING.delete(id); addEvent({ cmd: 'vault', ok: false, id: info.tabId, label: '민감 정보 입력 확인 시간 초과' });
        reject(new Error('owner did not confirm within 120 s. Ask them to press 입력 on the confirmation card in the side panel (내 정보), then retry')); }, CONFIRM_MS);
      PENDING.set(id, { info, expiresAt: Date.now() + CONFIRM_MS, resolve: ok => {
        clearTimeout(t); PENDING.delete(id);
        addEvent({ cmd: 'vault', ok: true, id: info.tabId, label: ok ? '민감 정보 입력 허용' : '민감 정보 입력 취소' });
        log(`vault: confirmation ${ok ? 'allowed' : 'declined'}`);
        ok ? resolve() : reject(new Error('owner pressed 취소 (declined the sensitive fill). Do not retry unless they ask'));
      } });
    });
  }
  async function confirmIfSensitive(args, used) {
    const sens = used.filter(i => i.sens === '민감');
    if (!sens.length) return;
    const m = (getTabMeta && getTabMeta(args.id)) || {};
    // v12: 주민번호 뒷자리 -> the card EVERY time (ownerApproved never skips it)
    const always = sens.some(isRrnBackItem);
    // the owner's own side-panel request ("가입해줘", "기입해") already covers it: no card (only while a panel chat runs)
    if (!always && args.ownerApproved === true && typeof canSkipConfirm === 'function' && canSkipConfirm()) {
      addEvent({ cmd: 'vault', ok: true, id: args.id, host: m.host || null, title: m.title || null, label: `민감 정보 입력 · 채팅 요청에 포함 (확인 생략) · ${sens.map(i => i.label).join(', ')}`.slice(0, 80) });
      log(`vault: sensitive fill covered by panel chat request (${sens.map(i => i.key).join(',')}) tab ${args.id}`);
      return;
    }
    if (always && args.ownerApproved === true) log(`vault: rrn_back needs the card even with ownerApproved (tab ${args.id})`);
    await askConfirm({ tabId: args.id, title: m.title || null, host: m.host || null, items: sens.map(i => ({ key: i.key, label: i.label })), test: !!args.testVault, ...(always ? { always: true } : {}) });
  }

  // fill: {id, map:{selector:'vault:key'|'key'} | fields:[{selector,key}]} -> worker args with values
  async function prepFill(args) {
    const items = await itemsFor(args);
    let pairs = [];
    if (args.map && typeof args.map === 'object' && !Array.isArray(args.map)) pairs = Object.entries(args.map).map(([selector, k]) => ({ selector, key: String(k) }));
    else if (Array.isArray(args.fields)) pairs = args.fields.map(f => ({ selector: f.selector, key: String(f.key) }));
    pairs = pairs.map(p => ({ selector: String(p.selector || ''), key: p.key.replace(/^\{\{\s*|\s*\}\}$/g, '').replace(/^vault:/i, '').trim().toLowerCase() }));
    if (!pairs.length) throw new Error('fill needs --map \'{"<css selector>":"vault:<key>"}\' (get it from `cli.js match <id>`)');
    if (pairs.length > 60) throw new Error('too many fields (max 60)');
    // keys may be derived: rrn_full / rrn_front6 / <주민번호 key>#N (v12)
    const res = new Map([...new Set(pairs.map(p => p.key))].map(k => [k, resolveKey(k, items)]));
    const missing = [...new Set([...res].flatMap(([k, r]) => !r ? [k] : r.missing || []))];
    if (missing.length) throw new Error(`내 정보에 없는(또는 값이 빈) 키: ${missing.join(', ')}. 있는 키: ${items.filter(i => i.value).map(i => i.key).join(', ') || '(없음)'}. owner에게 사이드 패널 "내 정보" 탭에 추가해 달라고 하세요`);
    if (pairs.some(p => !p.selector)) throw new Error('empty selector in --map');
    const used = [...new Set([...res.values()].flatMap(r => r.used))];
    await confirmIfSensitive(args, used);
    const { map, fields, testVault, ...rest } = args;
    delete rest.ownerApproved;
    return { args: { ...rest, fields: pairs.map(p => { const r = res.get(p.key);
      return { selector: p.selector, key: p.key, value: r.value, ...(r.used.length === 1 && isPasswordItem(r.used[0]) ? { pw: true } : {}), ...(r.rrn ? { rrn: true } : {}) }; }) },
      keys: [...res.keys()] };
  }
  async function prepRun(args) {
    const keys = placeholderKeys(args.code || '');
    if (!keys.length) return { args, keys: [] };
    const items = await itemsFor(args);
    const r = substitute(args.code, items);
    await confirmIfSensitive(args, r.used);
    const { testVault, ownerApproved, ...rest } = args;
    return { args: { ...rest, code: r.code }, keys: r.keys, subs: r.subs };
  }

  async function keysText(args = {}) {
    const items = await itemsFor(args);
    const notes = (await loadFile(vaultFileFor(args))).notes || [];
    if (!items.length && !notes.length) return '내 정보가 비어 있어요. owner에게 사이드 패널 "내 정보" 탭에서 항목을 추가해 달라고 하세요.';
    const L = ['키 · 이름 · 분류 · 민감 · 다른 이름 (값은 보이지 않음. fill --map 의 "vault:<키>" 또는 run 코드의 \'{{vault:<키>}}\'로 사용)'];
    for (const c of CATEGORIES) for (const i of items.filter(i => i.cat === c))
      L.push(`${i.key.padEnd(16)} ${i.label} · ${i.cat}${isPasswordItem(i) ? ' · 비밀번호(가입용: fill/run으로만, 비밀번호·비밀번호 확인 칸 둘 다)' : ''}${isRrnBackItem(i) ? ' · 주민번호 뒷자리(기입할 때마다 패널 확인 카드. --owner-approved로도 생략 안 됨)' : i.sens === '민감' ? ' · 민감(패널 확인 필요, 채팅 요청에 포함되면 --owner-approved)' : ''}${i.nofill ? ' · 자동 기입 안 함(파생 정보)' : ''}${i.value ? '' : ' · (값 없음)'}${i.aliases.length ? ' · ' + i.aliases.slice(0, 8).join('/') : ''}`);
    if (items.some(i => i.key === 'rrn7' || isRrnBackItem(i)))
      L.push('', '주민번호 파생 키 (match가 칸 배치를 보고 골라 줌): rrn_full = 13자리 한 칸(앞 6 + 뒷자리 7), rrn_front6 = 앞 6자리, <키>#N = N번째 숫자 한 칸 (예: rrn_back#1 ~ rrn_back#7). 보안 키패드 칸은 자동 입력 안 함(owner가 직접).');
    if (notes.length) {
      L.push('', '메모 (제목만. 내용은 owner의 사이드 패널에서만 보임):');
      for (const c of CATEGORIES) for (const n of notes.filter(n => n.cat === c)) L.push(`  ${n.title} · ${n.cat} · ${n.body.split('\n').length}줄`);
    }
    return L.join('\n');
  }

  // CLI bulk import (block comes from STDIN via the API body; output = counts + keys only, never values)
  async function importText(args = {}) {
    const f = vaultFileFor(args);
    await itemsFor(args);
    const cat = String(args.cat || '');
    if (!CATEGORIES.includes(cat)) throw new Error(`--category 는 다음 중 하나: ${CATEGORIES.join(', ')}`);
    const parsed = parseBlock(args.text);
    if (!parsed.rows.length) throw new Error('읽을 수 있는 행이 없어요 (형식: "항목<TAB 또는 공백 2칸>정보")');
    const wantNote = args.note !== false;
    const title = cleanStr(args.noteTitle, 60) || parsed.heading;
    if (wantNote && !title) throw new Error('메모 제목이 없어요 (--note-title 또는 첫 줄 제목)');
    let res, nb = { dropped: 0 };
    const out = await mutate(d => {
      const rows = previewRows(parsed, cat, d.items);
      if (wantNote) nb = noteBodyFrom(parsed, cat);
      res = applyBulk(d, rows, wantNote ? { title, body: nb.body, cat } : null);
    }, f);
    addEvent({ cmd: 'vault', ok: true, label: `내 정보 한꺼번에 추가: 추가 ${res.added.length} · 채움 ${res.filled.length} · 충돌 ${res.conflicts.length} · 건너뜀 ${res.skipped.length}${res.note && res.note.status === 'added' ? ' · 메모 1' : ''}` });
    log(`vault: bulk import (${res.added.length} added, ${res.conflicts.length} conflicts)`);
    return { category: cat, rows: parsed.rows.length, headerRowSkipped: parsed.headerSkipped, unparsedLines: parsed.unparsed.length,
      added: res.added, filledEmpty: res.filled, unchanged: res.same, conflicts: res.conflicts, skipped: res.skipped,
      note: res.note ? { title: res.note.title, status: res.note.status, ...(res.note.lines ? { lines: res.note.lines } : {}), ...(nb.dropped ? { droppedLines: nb.dropped } : {}), ...(res.note.reason ? { reason: res.note.reason } : {}) } : null,
      totals: { items: out.items.length, notes: out.notes.length } };
  }

  // ----- panel routes (/panel/vault/*): scoped panel token + extension Origin already checked by server.js -----
  const mask = v => { v = String(v || ''); if (!v) return ''; const tail = v.replace(/\s/g, '').slice(-2); return '•'.repeat(Math.min(8, Math.max(4, v.length - 2))) + tail; };
  function listOut(d, extra = {}) {
    return { categories: CATEGORIES, templates: TEMPLATES, updatedAt: d.updatedAt,
      items: d.items.map(i => ({ key: i.key, label: i.label, cat: i.cat, aliases: i.aliases, sens: i.sens, ac: i.ac, hasValue: !!i.value,
        value: i.sens === '민감' ? null : i.value, masked: i.sens === '민감' ? (isRrnBackItem(i) ? (i.value ? '•••••••' : '') : mask(i.value)) : null, ...(i.nofill ? { nofill: true } : {}) })),
      notes: (d.notes || []).map(n => ({ id: n.id, title: n.title, cat: n.cat, body: n.body, updatedAt: n.updatedAt })), ...extra };
  }
  async function mutate(fn, f = file) {
    const d = JSON.parse(JSON.stringify(await loadFile(f)));
    if (!Array.isArray(d.notes)) d.notes = [];
    const extra = await fn(d);
    await saveFile(d, f);
    await refreshRedactor();
    return listOut(d, extra || {});
  }
  async function handlePanel(route, u, req, res, sendJson, readBody) {
    const body = route.startsWith('POST') ? await readBody(req) : {};
    try {
      switch (route) {
        case 'POST /panel/vault/list': return sendJson(200, listOut(await loadFile(file))), true;
        case 'POST /panel/vault/reveal': {
          const it = (await loadFile(file)).items.find(i => i.key === String(body.key));
          if (!it) return sendJson(404, { error: '없는 항목' }), true;
          return sendJson(200, { value: it.value }), true;
        }
        case 'POST /panel/vault/save': {
          const out = await mutate(d => {
            const orig = body.origKey ? String(body.origKey) : null;
            const idx = orig ? d.items.findIndex(i => i.key === orig) : -1;
            if (orig && idx < 0) throw new Error('수정할 항목이 없어요');
            const raw = { ...body.item };
            if (idx < 0 && !(Array.isArray(raw.aliases) && raw.aliases.length)) {   // inline add (title + value only): suggested key/aliases/민감
              const sg = suggestFor(cleanStr(raw.label, 40), raw.cat);
              raw.aliases = sg.aliases; if (!raw.ac || !raw.ac.length) raw.ac = sg.ac;
              if (!raw.key && sg.key && KEY_RE.test(sg.key) && !d.items.some(i => i.key === sg.key)) raw.key = sg.key;
              if (sg.sens === '민감') raw.sens = '민감';
              if (sg.nofill && raw.nofill == null) raw.nofill = true;
            }
            if (idx >= 0 && raw.value == null && body.keepValue) raw.value = d.items[idx].value;
            if (idx >= 0 && raw.nofill == null) raw.nofill = d.items[idx].nofill === true;
            const it = normalizeItem(raw, d.items, orig);
            if (idx >= 0) d.items[idx] = it; else d.items.push(it);
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 ${idx >= 0 ? '수정' : '추가'}: ${it.label}` });
            return { saved: it.key };
          });
          log('vault: item saved'); return sendJson(200, out), true;
        }
        case 'POST /panel/vault/delete': {
          const out = await mutate(d => {
            const idx = d.items.findIndex(i => i.key === String(body.key)); if (idx < 0) throw new Error('없는 항목');
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 삭제: ${d.items[idx].label}` });
            const undo = toTrash('item', d.items[idx], idx);
            d.items.splice(idx, 1);
            return { undo };
          });
          log('vault: item deleted'); return sendJson(200, out), true;
        }
        case 'POST /panel/vault/move': {
          const out = await mutate(d => {
            const idx = d.items.findIndex(i => i.key === String(body.key)); if (idx < 0) throw new Error('없는 항목');
            const dir = body.dir < 0 ? -1 : 1, cat = d.items[idx].cat;
            let j = idx + dir; while (j >= 0 && j < d.items.length && d.items[j].cat !== cat) j += dir;
            if (j >= 0 && j < d.items.length) [d.items[idx], d.items[j]] = [d.items[j], d.items[idx]];
          });
          return sendJson(200, out), true;
        }
        case 'POST /panel/vault/export': {
          const d = await loadFile(file);
          addEvent({ cmd: 'vault', ok: true, label: `내 정보 내보내기 (${d.items.length}개${(d.notes || []).length ? ' · 메모 ' + d.notes.length : ''})` });
          log('vault: exported by owner (panel)');
          return sendJson(200, { format: 'chrome-live-vault-export', v: 1, exportedAt: new Date().toISOString(), items: d.items, notes: d.notes || [] }), true;
        }
        case 'POST /panel/vault/import': {
          const src = body.data && Array.isArray(body.data.items) ? body.data.items : Array.isArray(body.data) ? body.data : null;
          const srcNotes = body.data && Array.isArray(body.data.notes) ? body.data.notes : [];
          if (!src) throw new Error('JSON에 items 배열이 없어요');
          const out = await mutate(d => {
            if (body.mode === 'replace') { d.items = []; d.notes = []; }
            let added = 0, updated = 0; const skipped = [];
            for (const raw of src.slice(0, 300)) {
              try {
                const idx = raw && raw.key ? d.items.findIndex(i => i.key === String(raw.key).toLowerCase()) : -1;
                const it = normalizeItem(raw || {}, d.items, idx >= 0 ? d.items[idx].key : null);
                if (idx >= 0) { d.items[idx] = it; updated++; } else { d.items.push(it); added++; }
              } catch (e) { skipped.push({ label: cleanStr(raw && (raw.label || raw.key), 40), reason: e.message }); }
            }
            let notesAdded = 0;
            for (const raw of srcNotes.slice(0, NOTES_MAX)) {
              try {
                if (d.notes.length >= NOTES_MAX) throw new Error('메모가 너무 많아요');
                const n = normalizeNote(raw || {}, d.notes);
                if (d.notes.some(x => x.title === n.title && x.cat === n.cat && x.body === n.body)) continue;
                d.notes.push(n); notesAdded++;
              } catch (e) { skipped.push({ label: '메모 ' + cleanStr(raw && raw.title, 40), reason: e.message }); }
            }
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 가져오기: 추가 ${added} · 수정 ${updated} · 메모 ${notesAdded} · 건너뜀 ${skipped.length}` });
            return { imported: { added, updated, notesAdded, skipped } };
          });
          log('vault: imported'); return sendJson(200, out), true;
        }
        case 'POST /panel/vault/note-save': {
          const out = await mutate(d => {
            const orig = body.id ? String(body.id) : null;
            const idx = orig ? d.notes.findIndex(n => n.id === orig) : -1;
            if (orig && idx < 0) throw new Error('수정할 메모가 없어요');
            if (idx < 0 && d.notes.length >= NOTES_MAX) throw new Error('메모가 너무 많아요');
            const n = normalizeNote(body.note || {}, d.notes, idx >= 0 ? orig : null);
            if (idx >= 0) d.notes[idx] = n; else d.notes.push(n);
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 메모 ${idx >= 0 ? '수정' : '추가'}: ${n.title}` });
            return { savedNote: n.id };
          });
          log('vault: note saved'); return sendJson(200, out), true;
        }
        case 'POST /panel/vault/note-delete': {
          const out = await mutate(d => {
            const idx = d.notes.findIndex(n => n.id === String(body.id)); if (idx < 0) throw new Error('없는 메모');
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 메모 삭제: ${d.notes[idx].title}` });
            const undo = toTrash('note', d.notes[idx], idx);
            d.notes.splice(idx, 1);
            return { undo };
          });
          log('vault: note deleted'); return sendJson(200, out), true;
        }
        case 'POST /panel/vault/bulk-parse': {   // preview only, nothing saved
          const parsed = parseBlock(String(body.text || '').slice(0, NOTE_MAX));
          const d = await loadFile(file);
          const cat = CATEGORIES.includes(body.cat) ? body.cat : '기타';
          const nb = noteBodyFrom(parsed, cat);
          return sendJson(200, { heading: parsed.heading, headerSkipped: parsed.headerSkipped, unparsed: parsed.unparsed,
            rows: previewRows(parsed, cat, d.items), noteDropped: nb.dropped, noteLines: nb.body ? nb.body.split('\n').length : 0 }), true;
        }
        case 'POST /panel/vault/bulk-save': {
          const cat = CATEGORIES.includes(body.cat) ? body.cat : '기타';
          const parsed = parseBlock(String(body.text || '').slice(0, NOTE_MAX));
          const wantNote = !!(body.note && body.note.on);
          const nb = wantNote ? noteBodyFrom(parsed, cat) : { body: '', dropped: 0 };
          const title = wantNote ? (cleanStr(body.note.title, 60) || parsed.heading || '붙여넣은 정보') : '';
          const out = await mutate(d => {
            const res = applyBulk(d, Array.isArray(body.rows) ? body.rows : [], wantNote ? { title, body: nb.body, cat } : null);
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 한꺼번에 추가: 추가 ${res.added.length} · 채움 ${res.filled.length} · 충돌 ${res.conflicts.length} · 건너뜀 ${res.skipped.length}${res.note && res.note.status === 'added' ? ' · 메모 1' : ''}` });
            return { bulk: { ...res, noteDropped: nb.dropped } };
          });
          log('vault: bulk saved (panel)'); return sendJson(200, out), true;
        }
        case 'POST /panel/vault/restore': {   // undo a delete (the deleted object stays in daemon memory only)
          const t = TRASH.get(String(body.id));
          if (!t || Date.now() - t.at > 120000) return sendJson(404, { error: '되돌릴 수 있는 시간이 지났어요' }), true;
          const out = await mutate(d => {
            const list = t.kind === 'note' ? d.notes : d.items;
            const k = t.kind === 'note' ? 'id' : 'key';
            if (list.some(x => x[k] === t.obj[k])) throw new Error('같은 항목이 이미 있어요');
            list.splice(Math.min(t.index, list.length), 0, t.obj);
            addEvent({ cmd: 'vault', ok: true, label: `내 정보 삭제 되돌림: ${t.obj.label || t.obj.title}` });
            return { restored: t.obj[k] };
          });
          TRASH.delete(String(body.id));
          return sendJson(200, out), true;
        }
        case 'POST /panel/vault/confirm': {
          const p = PENDING.get(String(body.id));
          if (!p) return sendJson(404, { error: '이미 끝났거나 시간이 지난 요청이에요' }), true;
          p.resolve(body.ok === true);
          return sendJson(200, { ok: true }), true;
        }
      }
    } catch (e) { return sendJson(400, { error: String(e.message).slice(0, 200) }), true; }
    return false;
  }
  function pendingList() {
    return [...PENDING.entries()].map(([id, p]) => ({ id, tabId: p.info.tabId, title: p.info.title, host: p.info.host, items: p.info.items, test: p.info.test, ...(p.info.always ? { always: true } : {}), expiresAt: new Date(p.expiresAt).toISOString() }));
  }

  return {
    prepFill, prepRun, keysText, importText, itemsFor, handlePanel, pendingList, matchFields,
    redact: s => { try { return redactor(s); } catch { return s; } },
    redactPrompt: s => { try { return promptRedactor(s); } catch { return s; } },
    redactDeep: o => { try { return redactDeep(o, redactor); } catch { return o; } },
  };
}

module.exports = { initVault, CATEGORIES, TEMPLATES, SIGNUP_CAT, isPasswordItem, isRrnBackItem, forbiddenReason, makePromptRedactor, rrnPlan, resolveKey, normalizeItem, dpapi, loadFile, saveFile, substitute, placeholderKeys,
  makeRedactor, redactDeep, matchFields, scoreItem, DEFAULT_FILE,
  parseBlock, splitRow, suggestFor, previewRows, noteBodyFrom, applyBulk, normalizeNote, noteForbidden, noteRedactItems };
