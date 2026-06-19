-- =====================================================================
-- 관리자 설정 테이블 (admin_settings)
-- =====================================================================
--
-- 용도
--   현재는 관리자 비밀번호 해시 저장에 사용됩니다.
--   key='admin_password_hash' 에 PBKDF2-SHA256 해시(평문 아님)가 저장됩니다.
--
-- 실행 방법
--   Supabase 대시보드 → SQL Editor 에서 이 파일 내용을 한 번 실행하세요.
--   (또는 migration/run_sql.js 09 단계로 실행)
--
-- 안전성
--   - IF NOT EXISTS 사용 — 여러 번 실행해도 안전
--   - PRIMARY KEY 로 key 중복 방지
--   - Service Role Key 로만 접근 (RLS 활성화 + 기본 정책 없음)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.admin_settings (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS 활성화 — anon/authenticated 모두 직접 접근 차단
-- (서버에서는 SUPABASE_SERVICE_ROLE_KEY 로 우회 접근하므로 영향 없음)
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- updated_at 자동 갱신을 위한 트리거 (있어도 좋고 없어도 동작)
CREATE OR REPLACE FUNCTION public.set_admin_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_settings_updated_at ON public.admin_settings;
CREATE TRIGGER trg_admin_settings_updated_at
    BEFORE UPDATE ON public.admin_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.set_admin_settings_updated_at();

-- 확인
SELECT 'admin_settings 테이블 준비 완료' AS status;
