/* MES 웹 설정
 * ───────────────────────────────────────────────────────────────
 * 이 파일은 git 에 올라가도 된다. anon 키는 공개용이다.
 * Flutter 앱에 Firebase 설정을 넣는 것과 같다 — 이 키만으로는 아무것도 못 하고,
 * 실제 권한은 로그인한 사용자와 RLS 정책이 정한다.
 *
 * 절대 넣으면 안 되는 것: service_role 키, ANTHROPIC_API_KEY
 */
window.MES_CONFIG = {
  SUPABASE_URL: 'https://aokmrqfqvohoqiqqgpel.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFva21ycWZxdm9ob3FpcXFncGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMzg4MTUsImV4cCI6MjEwMzkxNDgxNX0.hpF3NGhLcUznMinjnEYrFnF7sAEIXbfXNiWXniIp8WU',

  // 로그인 화면에 이메일 도메인을 자동으로 붙인다.
  // 'admin' 만 입력해도 admin@cheil.local 로 로그인된다.
  EMAIL_DOMAIN: 'cheil.local',

  // 집계본이 담긴 mes_docs 의 행 이름
  SNAPSHOT_NAME: 'snapshot',
};
