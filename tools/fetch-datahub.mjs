#!/usr/bin/env node
/**
 * fetch-datahub.mjs — SGIS(국가데이터처) 빌드타임 스냅샷 생산자 (집계형)
 *
 * 흐름: 키 로드 → 인증(accessToken) → list.json(카탈로그) → 각 지표 data.json(year) →
 *       전 시군구 값 집계(avg/min/max/count/seoulAvg) → data/hub.json 원자적 기록.
 *
 * 실측 계약(_workspace/00_input/verified_api_contract.md, 2026-09-21):
 *   - 카탈로그: result.jibangCategoryAList[] (result는 배열이 아니라 객체)
 *   - 데이터  : data.json?jibang_idx_id=..&year=YYYY (year 필수, adm_cd 금지)
 *               → result.resultData[].data[] = { adm_cd(5자리 시군구), value(문자열) }
 *   - SGIS는 시군구 단위만 반환. 전국 단일값 없음 → 시군구 단순평균으로 집계.
 *     (⚠ 시군구 단순평균 ≠ 가구수 가중 전국비중. UI에서 "전국 시군구 평균"으로 라벨)
 *
 * 의존성 0(Node 내장 fetch/fs만). 실패 시 기존 data/hub.json 보존(부분/깨진 파일 미기록).
 *
 * 실행: node tools/fetch-datahub.mjs
 * 키:   env SGIS_CONSUMER_KEY / SGIS_CONSUMER_SECRET  또는  tools/secrets.local.json
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(TOOLS_DIR);
const CONFIG_PATH = join(TOOLS_DIR, 'indicators.config.json');
const SECRETS_PATH = join(TOOLS_DIR, 'secrets.local.json');
const DATA_DIR = join(ROOT_DIR, 'data');
const OUT_PATH = join(DATA_DIR, 'hub.json');
const TMP_PATH = join(DATA_DIR, 'hub.json.tmp');

const LOG = '[fetch-datahub]';
const TIMEOUT_MS = 15000;

const log = (...a) => console.log(LOG, ...a);
const warn = (...a) => console.warn(LOG, 'WARN', ...a);

/** 치명 중단: 로그 후 exit 1. tmp가 남아있으면 정리(원자성 보장). hub.json은 절대 미변경. */
function fatal(msg) {
  console.error(LOG, 'FATAL', msg);
  try { if (existsSync(TMP_PATH)) rmSync(TMP_PATH, { force: true }); } catch { /* noop */ }
  process.exit(1);
}

/** 같은-출처 아님(외부 SGIS) JSON GET. 15s 타임아웃. 실패는 throw. */
async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const reason = e && e.name === 'TimeoutError' ? `타임아웃(${TIMEOUT_MS}ms)` : (e && e.message) || String(e);
    throw new Error(`네트워크 오류: ${reason}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 파싱 실패 (응답 앞부분: ${text.slice(0, 120)})`);
  }
}

/** SGIS 응답에서 errCd가 토큰 만료를 뜻하는지 판별. */
function isTokenExpired(body) {
  if (!body) return false;
  if (body.errCd === -401) return true;
  const m = String(body.errMsg || '');
  return /token|토큰|expire|만료/i.test(m);
}

/** 키 로드: env 우선, 없으면 secrets.local.json. 둘 다 없으면 fatal. */
function loadKeys() {
  let key = process.env.SGIS_CONSUMER_KEY;
  let secret = process.env.SGIS_CONSUMER_SECRET;
  if (key && secret) {
    log('키 소스: 환경변수(SGIS_CONSUMER_KEY/SECRET)');
    return { key, secret };
  }
  if (existsSync(SECRETS_PATH)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(SECRETS_PATH, 'utf8'));
    } catch {
      fatal(`${SECRETS_PATH} JSON 파싱 실패 — 형식은 secrets.local.example.json 참고.`);
    }
    key = key || parsed.consumerKey;
    secret = secret || parsed.consumerSecret;
  }
  if (!key || !secret) {
    fatal(
      '인증 키 없음. 다음 중 하나로 제공하세요:\n' +
      '  1) 환경변수: SGIS_CONSUMER_KEY, SGIS_CONSUMER_SECRET\n' +
      `  2) 파일: ${SECRETS_PATH}  ({ "consumerKey": "...", "consumerSecret": "..." })\n` +
      '  → 발급 절차는 tools/README.md 참고. 기존 data/hub.json은 변경하지 않았습니다.'
    );
  }
  log('키 소스: tools/secrets.local.json');
  return { key, secret };
}

/** 인증 → accessToken. 실패 시 fatal. */
async function authenticate(base, key, secret) {
  const url = `${base}/auth/authentication.json?consumer_key=${encodeURIComponent(key)}&consumer_secret=${encodeURIComponent(secret)}`;
  let body;
  try {
    body = await getJson(url);
  } catch (e) {
    fatal(`인증 요청 실패: ${e.message}`);
  }
  if (body.errCd !== 0 || !body.result || !body.result.accessToken) {
    fatal(`인증 실패: errCd=${body.errCd} errMsg=${body.errMsg || '(없음)'}`);
  }
  log('인증 성공(accessToken 확보).');
  return body.result.accessToken;
}

/** 만료 시 1회 재인증하는 GET 래퍼. ctx.token은 갱신될 수 있음. */
async function getWithReauth(url, ctx, labelForLog) {
  const build = (t) => `${url}${url.includes('?') ? '&' : '?'}accessToken=${encodeURIComponent(t)}`;
  let body = await getJson(build(ctx.token));
  if (body.errCd !== 0 && isTokenExpired(body)) {
    warn(`${labelForLog}: 토큰 만료 추정(errCd=${body.errCd}) → 1회 재인증 후 재시도.`);
    ctx.token = await authenticate(ctx.base, ctx.key, ctx.secret);
    body = await getJson(build(ctx.token));
  }
  return body;
}

/** yearinfo(LIST 또는 객체배열)를 (string|number)[]로 정규화. */
function normalizeYears(yearinfo) {
  if (!Array.isArray(yearinfo)) return [];
  return yearinfo.map((y) => {
    if (y && typeof y === 'object') return y.year ?? y.yyyy ?? y.baseYear ?? String(y);
    return y;
  });
}

/** 소수 1자리 반올림(-0 방지). */
function round1(n) {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/** data.json 응답에서 시군구 행 배열 추출: result.resultData[].data[]. */
function extractRows(body) {
  const rd = body && body.result && body.result.resultData;
  if (!Array.isArray(rd)) return [];
  const rows = [];
  for (const block of rd) {
    if (block && Array.isArray(block.data)) rows.push(...block.data);
  }
  return rows;
}

/** 시군구 값 배열을 집계: {value(=avg), min, max, count, seoulAvg}. 유효값 0개면 null. */
function aggregate(rows) {
  const all = [];
  const seoul = [];
  for (const r of rows) {
    if (!r) continue;
    const n = Number(r.value);
    if (!Number.isFinite(n)) continue;
    all.push(n);
    if (String(r.adm_cd || '').startsWith('11')) seoul.push(n);
  }
  if (all.length === 0) return null;
  const avg = all.reduce((a, b) => a + b, 0) / all.length;
  const seoulAvg = seoul.length ? seoul.reduce((a, b) => a + b, 0) / seoul.length : null;
  return {
    value: round1(avg),
    min: round1(Math.min(...all)),
    max: round1(Math.max(...all)),
    count: all.length,
    seoulAvg: seoulAvg === null ? null : round1(seoulAvg),
  };
}

async function main() {
  // --- config 로드 ---
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    fatal(`${CONFIG_PATH} 로드/파싱 실패: ${e.message}`);
  }
  const base = config.base;
  const service = config.service || 'jibang/category_a';
  const year = String(config.year || '');
  if (!base || !year || !Array.isArray(config.indicators) || config.indicators.length === 0) {
    fatal('indicators.config.json 형식 오류: base / year / indicators[] 필요.');
  }

  const { key, secret } = loadKeys();

  // --- 인증 ---
  const token = await authenticate(base, key, secret);
  const ctx = { base, key, secret, token };

  // --- 카탈로그(list.json) — result.jibangCategoryAList[] ---
  const listUrl = `${base}/${service}/list.json`;
  let listBody;
  try {
    listBody = await getWithReauth(listUrl, ctx, 'list.json');
  } catch (e) {
    fatal(`카탈로그 요청 실패: ${e.message}`);
  }
  const catalogRaw =
    listBody && listBody.result && Array.isArray(listBody.result.jibangCategoryAList)
      ? listBody.result.jibangCategoryAList
      : null;
  if (listBody.errCd !== 0 || !catalogRaw) {
    fatal(`카탈로그 실패: errCd=${listBody.errCd} errMsg=${listBody.errMsg || '(없음)'} (result.jibangCategoryAList 없음)`);
  }
  log(`카탈로그 ${catalogRaw.length}건 수신.`);

  const catalogById = new Map();
  const catalog = catalogRaw.map((c) => {
    const item = {
      id: String(c.jibang_idx_id ?? ''),
      name: String(c.jibang_idx_nm ?? ''),
      unit: c.data_unit || '',
      years: normalizeYears(c.yearinfo),
    };
    catalogById.set(item.id, { ...item, formula: c.jibang_idx_exp || null });
    return item;
  });

  // --- 각 지표 data.json(year, adm_cd 금지) → 집계 ---
  const regional = [];
  for (const cfg of config.indicators) {
    const id = String(cfg.jibang_idx_id ?? '');
    if (!id) {
      warn(`지표 건너뜀: jibang_idx_id 미설정(${cfg.name || '(이름없음)'}).`);
      continue;
    }
    const params = new URLSearchParams({ jibang_idx_id: id, year });
    const dataUrl = `${base}/${service}/data.json?${params.toString()}`;

    let dataBody;
    try {
      dataBody = await getWithReauth(dataUrl, ctx, `data.json(${id})`);
    } catch (e) {
      warn(`지표 건너뜀(${id}): 요청 실패 — ${e.message}`);
      continue;
    }
    if (dataBody.errCd !== 0) {
      warn(`지표 건너뜀(${id}): errCd=${dataBody.errCd} errMsg=${dataBody.errMsg || '(없음)'}`);
      continue;
    }

    const rows = extractRows(dataBody);
    if (rows.length === 0) {
      warn(`지표 건너뜀(${id}): 빈 resultData[].data[].`);
      continue;
    }

    const agg = aggregate(rows);
    if (!agg) {
      warn(`지표 건너뜀(${id}): 유효 숫자값 0개.`);
      continue;
    }

    const cat = catalogById.get(id);
    regional.push({
      id,
      name: cfg.name || (cat && cat.name) || id,
      unit: cfg.unit || (cat && cat.unit) || '',
      value: agg.value,
      min: agg.min,
      max: agg.max,
      count: agg.count,
      seoulAvg: agg.seoulAvg,
      formula: (cat && cat.formula) || null,
    });
    log(
      `지표 ok(${id}): ${cfg.name} 전국평균=${agg.value}${cfg.unit || ''} ` +
      `(min ${agg.min} / max ${agg.max} / N=${agg.count} / 서울 ${agg.seoulAvg})`
    );
  }

  // --- 빈 regional 방어: 좋은 스냅샷을 빈 파일로 덮지 않음 ---
  if (regional.length === 0) {
    fatal('유효 지표 0개 — data/hub.json을 변경하지 않았습니다(기존 스냅샷 보존).');
  }

  // --- 완성 객체 ---
  const out = {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    year,
    source: config.source || '국가데이터처 SGIS',
    sourceUrl: config.sourceUrl || 'https://sgis.mods.go.kr',
    regional,
    catalog,
  };

  // --- 원자적 기록: tmp → rename ---
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TMP_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    renameSync(TMP_PATH, OUT_PATH);
  } catch (e) {
    fatal(`기록 실패: ${e.message}`);
  }
  log(`기록 완료: ${OUT_PATH} (지역지표 ${regional.length}개, 카탈로그 ${catalog.length}건).`);
}

main().catch((e) => fatal(`예상치 못한 오류: ${(e && e.stack) || e}`));
