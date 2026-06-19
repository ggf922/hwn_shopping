#!/usr/bin/env node
/**
 * ============================================================================
 * Supabase에 SQL 파일 실행 스크립트
 * ============================================================================
 * 
 * Supabase의 PostgREST는 임의 SQL을 직접 실행할 수 없습니다.
 * 따라서 다음 방법 중 하나를 사용합니다:
 * 
 * 1. 'pg' 패키지로 직접 PostgreSQL 연결 (DB 비밀번호 필요)
 * 2. Supabase Dashboard SQL Editor에 수동 붙여넣기
 * 
 * 이 스크립트는 방법 1을 시도하고, 실패 시 방법 2를 안내합니다.
 * 
 * 사용법:
 *   node migration/run_sql.js <sql_file>
 *   node migration/run_sql.js migration/01_schema.sql
 * ============================================================================
 */

require('dotenv').config({ path: __dirname + '/.env.migration' });
const fs = require('fs');
const path = require('path');

const sqlFile = process.argv[2];
if (!sqlFile) {
    console.error('사용법: node migration/run_sql.js <sql_file>');
    process.exit(1);
}

const sqlPath = path.resolve(sqlFile);
if (!fs.existsSync(sqlPath)) {
    console.error(`파일 없음: ${sqlPath}`);
    process.exit(1);
}

const sql = fs.readFileSync(sqlPath, 'utf-8');

// 방법: Supabase의 internal management endpoint 시도
// 정상적인 PostgREST는 SQL 실행을 지원하지 않으므로,
// pg 직접 연결을 위한 PG_CONNECTION_STRING 환경변수 확인

const PG_CONN = process.env.SUPABASE_DB_URL || process.env.PG_CONNECTION_STRING;

if (!PG_CONN) {
    console.log('');
    console.log('==========================================================');
    console.log('  📋 SQL 파일을 Supabase Dashboard에서 실행해주세요');
    console.log('==========================================================');
    console.log('');
    console.log('1. https://supabase.com/dashboard/project/efluojsyxoskhehbbjer/sql/new 접속');
    console.log(`2. 아래 파일 내용 전체를 복사해서 붙여넣기:`);
    console.log(`   ${sqlPath}`);
    console.log('3. 우측 하단 [Run] 클릭');
    console.log('4. 완료 후 이 메시지에 알려주세요');
    console.log('');
    console.log('또는 DB 비밀번호를 .env.migration 에 다음과 같이 추가하면 자동 실행 가능:');
    console.log('   SUPABASE_DB_URL=postgresql://postgres.efluojsyxoskhehbbjer:<DB_PASSWORD>@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres');
    console.log('');
    process.exit(2);
}

// pg로 직접 실행
(async () => {
    const { Client } = require('pg');
    const client = new Client({ connectionString: PG_CONN });
    
    try {
        await client.connect();
        console.log(`🔌 PostgreSQL 연결 성공`);
        console.log(`📜 SQL 실행 중: ${path.basename(sqlPath)} (${sql.length} bytes)`);
        
        const result = await client.query(sql);
        console.log(`✅ SQL 실행 완료`);
        
        if (Array.isArray(result)) {
            console.log(`   ${result.length} 개의 statement 실행됨`);
        } else if (result.rows) {
            console.log(`   결과: ${result.rows.length} 행`);
            if (result.rows.length > 0 && result.rows.length < 30) {
                console.log(JSON.stringify(result.rows, null, 2));
            }
        }
    } catch (e) {
        console.error(`❌ SQL 실행 실패: ${e.message}`);
        console.error(e);
        process.exit(1);
    } finally {
        await client.end();
    }
})();
