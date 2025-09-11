-- Migration: Disable automatic profile trigger and loosen profiles schema for app-driven profile creation
-- 1) Drop the auth.users -> public.profiles trigger if exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid WHERE t.tgname = 'create_user_profile' OR t.tgname = 'on_auth_user_created') THEN
    RAISE NOTICE 'Dropping existing auth -> profiles trigger...';
    -- Try both common trigger names
    BEGIN
      DROP TRIGGER IF EXISTS create_user_profile ON auth.users;
    EXCEPTION WHEN others THEN
      -- ignore
    END;
    BEGIN
      DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    EXCEPTION WHEN others THEN
      -- ignore
    END;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 2) Make profile fields nullable so the trigger isn't required to populate them
-- Only id should be required (primary key). Adjust column names if your schema differs.
ALTER TABLE public.profiles
  ALTER COLUMN username DROP NOT NULL,
  ALTER COLUMN public_key DROP NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL,
  ALTER COLUMN bio DROP NOT NULL,
  ALTER COLUMN gender DROP NOT NULL;

-- 3) Ensure RLS is enabled and policies are sane: service_role allowed to insert, authenticated can insert their own
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can insert profiles" ON public.profiles;
CREATE POLICY "Service role can insert profiles"
ON public.profiles FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile"
ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));

-- Ensure users can manage own profile
DROP POLICY IF EXISTS "Users can manage own profile" ON public.profiles;
CREATE POLICY "Users can manage own profile"
ON public.profiles FOR ALL TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

-- Optionally keep public read (adjust as needed)
DROP POLICY IF EXISTS "Profiles are publicly readable" ON public.profiles;
CREATE POLICY "Profiles are publicly readable"
ON public.profiles FOR SELECT TO public USING (true);
