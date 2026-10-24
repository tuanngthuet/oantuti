import json
import pathlib
import subprocess
import tempfile
import time

root = pathlib.Path.cwd()
report = root / 'logs/portable-verification'
compose = root / 'worker_image/portable/compose.yaml'
project = 'oantuti-portable-smoke'
mock_source = '''import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
control = {'mode':'stopped', 'max_concurrent':4, 'revision':1}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or '{}')
        if self.path=='/workers/register':
            print(json.dumps({'event':'register','worker_id':body['worker_id']}),flush=True)
            result={'generation':1,'control':control}
        elif self.path=='/workers/supervisor-heartbeat':
            print(json.dumps({'event':'heartbeat','state':body['state']}),flush=True)
            result={'control':control}
        else: result={'recovered':0,'lost':0}
        payload=json.dumps(result).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
ThreadingHTTPServer(('0.0.0.0',8000),Handler).serve_forever()
'''

def docker(*args):
    return subprocess.check_output(['docker',*args],stderr=subprocess.STDOUT,text=True)

with tempfile.TemporaryDirectory(prefix='oantuti-portable-test-') as temporary:
    folder=pathlib.Path(temporary)
    (folder/'mock.py').write_text(mock_source)
    override = {'services':{
        'mock-backend':{'image':'oantuti-worker-python:bundled','pull_policy':'never',
            'entrypoint':['/opt/worker-venv/bin/python','-u','/mock.py'],
            'volumes':[f'{folder}/mock.py:/mock.py:ro']},
        'worker-python':{'environment':{'BACKEND_URL':'http://mock-backend:8000'},
            'depends_on':['mock-backend']}}}
    (folder/'override.json').write_text(json.dumps(override))
    base=['compose','-p',project,'-f',str(compose),'-f',str(folder/'override.json')]
    def dc(*args): return docker(*base,*args)
    def wait_event(event,count=1):
        end=time.monotonic()+35
        while time.monotonic()<end:
            logs=dc('logs','--no-log-prefix','mock-backend')
            events=[json.loads(line) for line in logs.splitlines() if line.startswith('{')]
            selected=[e for e in events if e['event']==event]
            if len(selected)>=count: return selected
            time.sleep(1)
        raise AssertionError('Timeout '+event+'\n'+dc('logs'))
    try:
        print(dc('up','-d','--no-build'),flush=True)
        registered=wait_event('register')
        wait_event('heartbeat',2)
        cid=dc('ps','-q','worker-python').strip()
        info=json.loads(docker('inspect',cid))[0]
        assert info['State']['Running']
        assert info['Config']['User']=='10001:10001'
        assert info['HostConfig']['ReadonlyRootfs']
        assert not info['HostConfig']['Privileged']
        assert not info['NetworkSettings']['Ports']
        print('PASS start: non-root, read-only, no privileged, no published ports; supervisor heartbeats',flush=True)
        print(dc('stop','worker-python'),flush=True)
        info=json.loads(docker('inspect',cid))[0]
        assert not info['State']['Running'] and info['State']['ExitCode']==0
        print('PASS stop: exit code 0',flush=True)
        dc('up','-d','--no-build','--force-recreate','worker-python')
        registered=wait_event('register',2)
        assert registered[0]['worker_id']==registered[-1]['worker_id']
        print('PASS recreate: stable worker identity',flush=True)
        (report/'smoke.log').write_text(dc('logs','--no-color'))
        dc('down')
        dc('up','-d','--no-build')
        registered_again=wait_event('register')
        assert registered_again[0]['worker_id']==registered[0]['worker_id']
        print('PASS down/up: identity volume retained',flush=True)
    finally:
        print(dc('down','-v'),flush=True)
