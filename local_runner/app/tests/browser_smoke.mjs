// Developer-only smoke test: uses the repository's existing Playwright installation.
// Run from repository root after: python3 -B local_runner/app/build_bundle.py
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const {chromium} = await import(pathToFileURL(path.resolve('Frontend/node_modules/playwright-core/index.mjs')));
const temp = mkdtempSync(path.join(tmpdir(), 'Thử agent local '));
const zip = path.resolve('local_runner/app/dist/Oantuti-Local.zip');
execFileSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, temp]);
const root = path.join(temp, 'Oantuti-Local');
const agent = path.join(root, 'my_agent.py');
const slowAgent = 'import time\ndef agent(o, c):\n    time.sleep(0.35)\n    return o["valid_moves"][0]\n';
writeFileSync(agent, slowAgent);
// Launch the shipped Linux entrypoint from a different working directory.
const server = spawn('bash', [path.join(root, 'app/Chay.sh'), '--no-browser'], {cwd:tmpdir(),stdio:['ignore','pipe','pipe']});
let browser;
try {
 const url = await new Promise((resolve,reject)=>{
  let output='';const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000);
  server.stdout.on('data', chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
  server.on('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+' '+output));});
 });
 browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);await page.waitForSelector('.cell');
 assert.equal(await page.locator('.cell').count(),81);
 const guide=await browser.newPage();await guide.goto(url+'/guide');
 await guide.getByRole('link',{name:'hướng dẫn Linux từng bước'}).click();
 assert.match(await guide.locator('h1').textContent(),/Linux/);
 assert.match(await guide.locator('body').textContent(),/bash app\/Chay.sh/);
 await guide.getByRole('link',{name:'hướng dẫn agent từ số 0'}).click();
 assert.match(await guide.locator('h1').textContent(),/agent đầu tiên/);
 await guide.close();
 const forbidden=await page.request.post(url+'/api/start');assert.equal(forbidden.status(),403);
 await page.getByRole('button',{name:'Chạy thử với Greedy',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('#moves button').length>=3);
 await page.getByRole('button',{name:'◀ Trước',exact:true}).click();
 assert.equal(await page.locator('#live').textContent(),'Đang xem lịch sử');
 const pausedStep=await page.locator('#slider').inputValue();
 const countBefore=await page.locator('#moves button').count();
 await page.waitForFunction(before=>document.querySelectorAll('#moves button').length>before,countBefore);
 assert.equal(await page.locator('#slider').inputValue(),pausedStep);
 await page.getByRole('button',{name:'Về hiện tại',exact:true}).click();
 assert.equal(await page.locator('#live').textContent(),'● Theo dõi trực tiếp');
 await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Đang chạy');
 assert.equal(await page.locator('#live').textContent(),'● Theo dõi trực tiếp');
 await page.getByRole('button',{name:'Dừng trận',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='Đã dừng');
 await page.waitForFunction(()=>document.querySelector('#saved').textContent.includes('Đã lưu'));
 // User saves a new file; next run must read it and report the exact source line.
 writeFileSync(agent,'def agent(o,c):\n    value = 1\n    return value / 0\n');
 await page.getByRole('button',{name:'Chạy lại với Greedy',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#error-title').textContent.includes('ZeroDivisionError'));
 assert.match(await page.locator('#error-title').textContent(),/my_agent.py · dòng 3/);
 assert.match(await page.locator('#snippet').textContent(),/> 3:.*value \/ 0/);
 await page.waitForFunction(()=>document.querySelector('#saved').textContent.includes('Đã lưu'));
 // Fixing the same file must clear errors and create a fresh match.
 writeFileSync(agent,readFileSync('local_runner/my_agent.py','utf8'));
 await page.getByRole('button',{name:'Chạy lại với Greedy',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='Đã kết thúc');
 assert.equal(await page.locator('#error').isVisible(),false);
 await page.getByRole('button',{name:'|◀ Đầu',exact:true}).click();
 assert.equal(await page.locator('#slider').inputValue(),'0');
 await page.getByRole('button',{name:'Sau ▶',exact:true}).click();
 assert.equal(await page.locator('#slider').inputValue(),'1');
 await page.locator('#speed').selectOption('300');await page.getByRole('button',{name:'Phát',exact:true}).click();
 await page.waitForFunction(()=>Number(document.querySelector('#slider').value)>1);
 await page.getByRole('button',{name:'Tạm dừng xem',exact:true}).click();
 const response=await page.request.get(url+'/download/replay');assert.equal(response.status(),200);
 const replayPath=path.join(temp,'replay offline.html');writeFileSync(replayPath,await response.text());
 const replay=await browser.newPage();await replay.context().setOffline(true);
 await replay.goto(pathToFileURL(replayPath).href);await replay.waitForSelector('.cell');
 assert.equal(await replay.locator('.cell').count(),81);
 await replay.getByRole('button',{name:'Sau ▶',exact:true}).click();
 assert.equal(await replay.locator('#slider').inputValue(),'1');
 await replay.screenshot({path:path.resolve('local_runner/app/dist/replay-preview.png'),fullPage:true});
 await replay.context().setOffline(false);
 await page.getByRole('button',{name:'Thoát công cụ',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Đã thoát công cụ'));
 assert.deepEqual(errors,[]);
 console.log('PASS Linux ZIP: bash launcher from another cwd, Vietnamese/spaced paths, Linux guide links, live, seek while running, follow, reload, cancellation, exact error line, rerun saved source, replay controls, offline HTML, token protection, shutdown.');
} finally {
 if(browser)await browser.close();
 server.kill('SIGINT');
 await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));
 rmSync(temp,{recursive:true,force:true});
}
