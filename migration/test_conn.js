require('dotenv').config({ path: __dirname + '/.env.migration' });
// Node 20 호환: ws를 글로벌 WebSocket으로 등록
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = require('ws');
}
const { createClient } = require('@supabase/supabase-js');

(async () => {
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
    );
    
    console.log('🔍 Supabase 연결 테스트...');
    console.log('   URL:', process.env.SUPABASE_URL);
    
    try {
        const { data, error } = await supabase
            .from('_health_check_dummy_xyz')
            .select('*')
            .limit(1);
        
        if (error) {
            if (error.message.includes('does not exist') || 
                error.message.includes('Could not find') ||
                error.code === '42P01' ||
                error.code === 'PGRST205') {
                console.log('✅ Supabase 연결 성공 (예상된 테이블 없음 오류)');
                console.log('   오류코드:', error.code);
                console.log('   메시지:', error.message);
                return;
            }
            console.log('⚠️  응답:', error.message);
            console.log('   상세:', JSON.stringify(error));
            return;
        }
        console.log('✅ Supabase 연결 성공');
    } catch (e) {
        console.log('❌ 연결 실패:', e.message);
        process.exit(1);
    }
})();
