-- ============================================================
-- 하원나라 Phase 3 - Supabase Storage 버킷 생성
-- ============================================================
-- 실행 위치: Supabase Dashboard → SQL Editor → New query
-- 안전성: 멱등(idempotent). 여러 번 실행해도 안전합니다.
--
-- 만들 것:
--   1. product-images 버킷 (Public, 5MB 제한, 이미지 mime만 허용)
--   2. Storage 정책 (RLS):
--        - 누구나(anon, authenticated) READ 가능 (Public 버킷이라 사실 정책 없어도 읽힘)
--        - service_role 만 INSERT/UPDATE/DELETE 가능
--          → 서버(Express/Vercel)는 service_role 키로 동작하므로 OK
--          → 브라우저(anon 키)에서는 직접 업로드 불가 → 반드시 /api/upload 통과
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. 버킷 생성
-- ────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,                                  -- public 버킷
  5242880,                               -- 5MB
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ────────────────────────────────────────────────────────────
-- 2. 기존 정책 정리 후 재생성 (멱등)
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "product_images_public_read"     ON storage.objects;
DROP POLICY IF EXISTS "product_images_service_insert"  ON storage.objects;
DROP POLICY IF EXISTS "product_images_service_update"  ON storage.objects;
DROP POLICY IF EXISTS "product_images_service_delete"  ON storage.objects;

-- 2-1. 공개 읽기
CREATE POLICY "product_images_public_read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'product-images');

-- 2-2. service_role 만 쓰기/수정/삭제
-- (service_role 키는 RLS를 우회하지만, 명시적으로 정책을 두면 의도가 더 분명함)
CREATE POLICY "product_images_service_insert"
ON storage.objects FOR INSERT
TO service_role
WITH CHECK (bucket_id = 'product-images');

CREATE POLICY "product_images_service_update"
ON storage.objects FOR UPDATE
TO service_role
USING (bucket_id = 'product-images');

CREATE POLICY "product_images_service_delete"
ON storage.objects FOR DELETE
TO service_role
USING (bucket_id = 'product-images');


-- ────────────────────────────────────────────────────────────
-- 3. 검증
-- ────────────────────────────────────────────────────────────
-- 버킷이 정상 생성됐는지
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
WHERE id = 'product-images';

-- 정책이 4개 모두 등록됐는지 (public_read / service_insert/update/delete)
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname LIKE 'product_images_%'
ORDER BY policyname;

-- 기대 결과:
--   buckets : 1행 (public=true, file_size_limit=5242880)
--   policies: 4행
