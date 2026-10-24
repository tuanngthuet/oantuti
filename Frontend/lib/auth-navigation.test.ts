import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { safeReturnTo, authLink } from './auth-navigation';
import { middleware } from '@/middleware';
const secret = 'auth-navigation-test-secret-at-least-32-characters';
beforeEach(() => vi.stubEnv('SESSION_SECRET', secret));
afterEach(() => vi.unstubAllEnvs());
it.each([undefined, null, ['/', '/admin'], '', 'https://evil.test', '//evil.test', '/\\evil.test',
  '/%2f%2fevil.test', '/%5cevil.test', '/%252f%252fevil.test', '/%00x', '/bad\npath',
  '/login', '/register?redirect=/login', '/api/auth/logout', '/_next/a', '/%E0%A4%A', '/a/../login'])
('rejects unsafe/looping destinations: %s', value => {
  expect(safeReturnTo(value)).toBe('/dashboard');
});
it.each(['/dashboard', '/arena/submit?template=first&tab=mine', '/arena/friendly', '/arena/agents/1/history?matchId=3', '/admin/workers'])
('preserves safe application destination: %s', value => expect(safeReturnTo(value)).toBe(value));
it('keeps the same destination when switching between login and registration', () => {
  const target = '/arena/submit?tab=mine&from=dashboard';
  expect(new URL(authLink('register', target), 'http://localhost').searchParams.get('redirect')).toBe(target);
});
async function token(admin = false, expires = '1h', userId = '1') {
  return new SignJWT({ username: 'test_user', is_admin: admin }).setProtectedHeader({alg:'HS256'})
    .setSubject(userId).setIssuedAt().setExpirationTime(expires).sign(new TextEncoder().encode(secret));
}
function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, cookie ? { headers: { cookie: `auth_session=${cookie}` } } : {});
}
it.each(['/dashboard','/arena/leaderboard','/arena/agents/1/history?matchId=2','/arena/replay/rating/1'])
('leaves public pages accessible without a session: %s', async path => {
  expect((await middleware(request(path))).headers.get('location')).toBeNull();
});
it.each(['/arena/submit?template=first','/arena/friendly?tab=history','/admin/workers','/team'])
('redirects protected pages before rendering and retains query: %s', async path => {
  const response = await middleware(request(path));
  const location = new URL(response.headers.get('location')!);
  expect(location.pathname).toBe('/login'); expect(location.searchParams.get('redirect')).toBe(path);
});
it('allows ordinary users into ordinary features, not admin pages', async () => {
  const cookie = await token();
  expect((await middleware(request('/arena/submit',cookie))).headers.get('location')).toBeNull();
  expect((await middleware(request('/arena/friendly',cookie))).headers.get('location')).toBeNull();
  expect(new URL((await middleware(request('/admin/workers',cookie))).headers.get('location')!).pathname).toBe('/403');
});
it('allows signed-in admins into admin pages', async () => {
  expect((await middleware(request('/admin/workers',await token(true)))).headers.get('location')).toBeNull();
});
it('treats expired, malformed and invalid-subject sessions as guests', async () => {
  for (const cookie of ['invalid', await token(false,'-1h'), await token(false,'1h','NaN')]) {
    expect(new URL((await middleware(request('/arena/submit',cookie))).headers.get('location')!).pathname).toBe('/login');
  }
});
it('fails closed when the session secret is missing', async () => {
  vi.stubEnv('SESSION_SECRET','');
  expect(new URL((await middleware(request('/arena/submit'))).headers.get('location')!).pathname).toBe('/403');
});
