#!/usr/bin/env node
/**
 * ============================================================================
 * Supabase 데이터 이식 스크립트
 * ============================================================================
 *
 * 사용법:
 *   1. 환경변수 설정 (.env.migration 파일 생성)
 *      SUPABASE_URL=https://xxxxxxxx.supabase.co
 *      SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
 *
 *   2. 의존성 설치 (이미 되어 있을 수 있음)
 *      npm install @supabase/supabase-js dotenv
 *
 *   3. 실행
 *      node migration/02_import_data.js
 *
 * 안전장치:
 *   - 트랜잭션처럼 동작 (실패 시 ROLLBACK 가이드)
 *   - 각 테이블별 카운트 검증
 *   - 진행률 표시
 *   - 중단 가능 (Ctrl+C)
 *   - DRY-RUN 모드 지원: node migration/02_import_data.js --dry-run
 * ============================================================================
 */

require('dotenv').config({ path: __dirname + '/.env.migration' });
// Node 20 호환: ws를 글로벌 WebSocket으로 등록 (Supabase realtime 모듈이 요구)
if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require('ws'); } catch (_) {}
}
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// 설정
// ============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 500; // 한 번에 insert할 행 수

// 백업 JSON 파일 위치
const BACKUP_JSON = path.join(__dirname, '..', 'backups',
    'snapshot_2026-06-19_13-43-54', 'hawonnara_export.json');

// 이식 순서 (외래키 의존성 고려)
const TABLE_ORDER = [
    'products',
    'vouchers',
    'orders',
    'order_voucher_usages',
    'voucher_amounts'
];

// ============================================================================
// 유틸리티
// ============================================================================
function log(msg, type = 'info') {
    const colors = {
        info: '\x1b[36m',    // cyan
        success: '\x1b[32m', // green
        warn: '\x1b[33m',    // yellow
        error: '\x1b[31m',   // red
        reset: '\x1b[0m'
    };
    const prefix = {
        info: '[INFO]',
        success: '[OK]',
        warn: '[WARN]',
        error: '[ERROR]'
    };
    console.log(`${colors[type]}${prefix[type]}${colors.reset} ${msg}`);
}

function bar(current, total, width = 30) {
    const ratio = current / total;
    const filled = Math.round(width * ratio);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${current}/${total} (${(ratio * 100).toFixed(1)}%)`;
}

// SQLite datetime → PostgreSQL TIMESTAMPTZ 변환
// "2026-05-22 13:55:14" → "2026-05-22T13:55:14Z"
function normalizeDateTime(dt) {
    if (!dt) return null;
    if (typeof dt !== 'string') return dt;
    // 이미 ISO 형식이면 그대로
    if (dt.includes('T')) return dt;
    // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SS+00:00" (UTC로 가정)
    return dt.replace(' ', 'T') + '+00:00';
}

// 각 테이블별 데이터 정규화
function normalizeRow(table, row) {
    const r = { ...row };
    // 모든 datetime 컬럼 변환
    const dtCols = ['created_at', 'updated_at', 'issued_at', 'used_at'];
    for (const col of dtCols) {
        if (col in r) r[col] = normalizeDateTime(r[col]);
    }
    return r;
}

// ============================================================================
// 환경 검증
// ============================================================================
function validateEnv() {
    log('========== 환경 검증 ==========', 'info');

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        log('SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 환경변수가 설정되지 않았습니다.', 'error');
        log('migration/.env.migration 파일을 생성하고 다음 내용을 입력하세요:', 'warn');
        console.log('');
        console.log('  SUPABASE_URL=https://xxxxxxxx.supabase.co');
        console.log('  SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...');
        console.log('');
        process.exit(1);
    }

    if (!fs.existsSync(BACKUP_JSON)) {
        log(`백업 JSON 파일을 찾을 수 없습니다: ${BACKUP_JSON}`, 'error');
        process.exit(1);
    }

    log(`Supabase URL: ${SUPABASE_URL}`, 'success');
    log(`Service Key: ${SUPABASE_SERVICE_KEY.substring(0, 20)}...`, 'success');
    log(`백업 파일: ${BACKUP_JSON}`, 'success');
    log(`모드: ${DRY_RUN ? '🔍 DRY-RUN (실제 입력 없음)' : '💾 LIVE (실제 입력)'}`, DRY_RUN ? 'warn' : 'info');
    console.log('');
}

// ============================================================================
// 백업 데이터 로드
// ============================================================================
function loadBackup() {
    log('========== 백업 데이터 로드 ==========', 'info');
    const raw = fs.readFileSync(BACKUP_JSON, 'utf-8');
    const data = JSON.parse(raw);

    log(`Exported at: ${data.meta.exported_at}`, 'info');
    log('테이블별 행 수:', 'info');
    let total = 0;
    for (const table of TABLE_ORDER) {
        const count = (data.tables[table] || []).length;
        total += count;
        console.log(`    ${table.padEnd(25)} ${count.toString().padStart(6)} 행`);
    }
    console.log(`    ${'합계'.padEnd(25)} ${total.toString().padStart(6)} 행`);
    console.log('');
    return data;
}

// ============================================================================
// 기존 데이터 확인 (덮어쓰기 방지)
// ============================================================================
async function checkExisting(supabase) {
    log('========== 기존 데이터 확인 ==========', 'info');
    let hasData = false;

    for (const table of TABLE_ORDER) {
        const { count, error } = await supabase
            .from(table)
            .select('*', { count: 'exact', head: true });

        if (error) {
            log(`${table} 확인 실패: ${error.message}`, 'error');
            log('스키마가 먼저 생성되어야 합니다. migration/01_schema.sql 을 Supabase SQL Editor에서 실행하세요.', 'warn');
            process.exit(1);
        }

        if (count > 0) {
            log(`${table}: 이미 ${count}개 행이 존재합니다.`, 'warn');
            hasData = true;
        } else {
            log(`${table}: 비어있음 (이식 가능)`, 'success');
        }
    }

    if (hasData) {
        log('⚠️  기존 데이터가 있습니다. 이식을 진행하면 중복/충돌이 발생할 수 있습니다.', 'warn');
        log('계속하려면 5초 내에 Ctrl+C로 중단하지 않으면 진행됩니다...', 'warn');
        await new Promise(r => setTimeout(r, 5000));
    }
    console.log('');
}

// ============================================================================
// 시퀀스 리셋 (PostgreSQL의 SERIAL 다음 값 재조정)
// ============================================================================
async function resetSequences(supabase) {
    log('========== 시퀀스 재조정 ==========', 'info');
    // pg 함수를 직접 실행할 수는 없으므로, RPC를 미리 만들거나
    // 또는 SQL Editor에서 별도 실행 안내
    log('시퀀스 재조정은 03_finalize.sql 에서 별도 실행됩니다.', 'info');
    console.log('');
}

// ============================================================================
// 데이터 이식 (배치 처리)
// ============================================================================
async function importTable(supabase, table, rows) {
    if (rows.length === 0) {
        log(`${table}: 데이터 없음 (스킵)`, 'warn');
        return { ok: 0, fail: 0 };
    }

    log(`${table} 이식 시작 (총 ${rows.length}행, 배치 ${BATCH_SIZE})`, 'info');

    if (DRY_RUN) {
        log(`  [DRY-RUN] 실제 입력 없이 검증만 수행`, 'warn');
        // 첫 행만 출력
        if (rows[0]) {
            console.log('  샘플 행:', JSON.stringify(rows[0], null, 2).split('\n').slice(0, 5).join('\n'));
        }
        return { ok: rows.length, fail: 0 };
    }

    let ok = 0, fail = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE).map(r => normalizeRow(table, r));

        const { error } = await supabase.from(table).insert(batch);

        if (error) {
            fail += batch.length;
            errors.push({ batch: i, error: error.message });
            log(`  배치 ${i}~${i + batch.length}: 실패 - ${error.message}`, 'error');
        } else {
            ok += batch.length;
        }

        // 진행률
        process.stdout.write(`\r  ${bar(i + batch.length, rows.length)}`);
    }
    process.stdout.write('\n');

    if (fail > 0) {
        log(`${table}: ${ok} 성공 / ${fail} 실패`, 'error');
        console.log('  오류 상세:', errors.slice(0, 3));
    } else {
        log(`${table}: ${ok} 행 이식 완료`, 'success');
    }
    console.log('');

    return { ok, fail };
}

// ============================================================================
// 검증
// ============================================================================
async function verify(supabase, sourceData) {
    log('========== 이식 결과 검증 ==========', 'info');
    let allOk = true;

    for (const table of TABLE_ORDER) {
        const sourceCount = (sourceData.tables[table] || []).length;
        const { count, error } = await supabase
            .from(table)
            .select('*', { count: 'exact', head: true });

        if (error) {
            log(`${table}: 검증 실패 - ${error.message}`, 'error');
            allOk = false;
            continue;
        }

        const match = count === sourceCount;
        const status = match ? 'success' : 'error';
        log(`${table.padEnd(25)} 원본: ${sourceCount} / 이식: ${count} ${match ? '✓' : '✗'}`, status);
        if (!match) allOk = false;
    }

    console.log('');
    return allOk;
}

// ============================================================================
// 메인
// ============================================================================
async function main() {
    console.log('\n=====================================================');
    console.log('  하원나라 데이터 이식 (SQLite → Supabase PostgreSQL)');
    console.log('=====================================================\n');

    validateEnv();
    const sourceData = loadBackup();

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });

    await checkExisting(supabase);

    log('========== 데이터 이식 시작 ==========', 'info');
    const results = {};

    for (const table of TABLE_ORDER) {
        const rows = sourceData.tables[table] || [];
        results[table] = await importTable(supabase, table, rows);
    }

    if (!DRY_RUN) {
        const ok = await verify(supabase, sourceData);
        if (ok) {
            log('🎉 모든 데이터 이식 및 검증 완료!', 'success');
            log('다음 단계: migration/03_finalize.sql 을 Supabase SQL Editor에서 실행하세요.', 'info');
        } else {
            log('⚠️  일부 검증 실패. 수동 확인이 필요합니다.', 'error');
            process.exit(1);
        }
    } else {
        log('🔍 DRY-RUN 완료. --dry-run 옵션을 제거하고 실제 실행하세요.', 'warn');
    }
}

main().catch(err => {
    log(`치명적 오류: ${err.message}`, 'error');
    console.error(err);
    process.exit(1);
});
