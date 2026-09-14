"""Explicit public model bootstrap. Never invoked by inference or given photos."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'scripts/imo3d-joint-depth-artifacts.json'
DEPENDENCIES=ROOT/'work/joint-depth-python'
RUNTIME_PARTS=['reconstruction-python-verified','room-vision-python-verified','vlm-python-verified','layout-python-verified','joint-depth-python','da3-python']


def checksum(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()


def public_artifact_url(url):
    parsed=urllib.parse.urlparse(url);host=(parsed.hostname or '').lower()
    return parsed.scheme=='https' and not parsed.username and not parsed.password and (host in {'huggingface.co','www.apache.org','apache.org'} or host.endswith('.hf.co') or host.endswith('.huggingface.co'))


class PublicArtifactRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,request,response,code,message,headers,new_url):
        if not public_artifact_url(new_url):raise ValueError('Model artifact redirected outside its approved public provider')
        return super().redirect_request(request,response,code,message,headers,new_url)


def artifact_target(entry):
    target=(ROOT/entry['target']).resolve()
    if not target.is_relative_to((ROOT/'work').resolve()) or Path(ROOT/entry['target']).is_symlink():raise ValueError('Artifact target must be a regular path inside BMK-Web/work')
    if not public_artifact_url(entry['url']):raise ValueError('Only official public Hugging Face/Apache model sources are allowed')
    return target


def ensure_artifact(entry,verify_only=False):
    path=artifact_target(entry)
    if path.is_file() and path.stat().st_size==entry['bytes'] and checksum(path)==entry['sha256']:
        return {'name':entry['name'],'status':'verified','bytes':entry['bytes']}
    if verify_only:raise ValueError('Missing or mismatched local artifact: '+entry['name'])
    path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_suffix(path.suffix+'.part')
    if temporary.is_symlink():raise ValueError('Artifact temporary file cannot be a link')
    opener=urllib.request.build_opener(PublicArtifactRedirect());total=0;digest=hashlib.sha256();last=0
    request=urllib.request.Request(entry['url'],headers={'User-Agent':'BMK-Web-local-model-setup'})
    with opener.open(request,timeout=180) as response,temporary.open('wb') as output:
        while chunk:=response.read(1024*1024):
            total+=len(chunk)
            if total>entry['bytes']:raise ValueError('Unexpected public artifact size: '+entry['name'])
            digest.update(chunk);output.write(chunk)
            if total-last>64*1024*1024:
                print(json.dumps({'event':'download_progress','name':entry['name'],'bytes':total,'total':entry['bytes']}),flush=True);last=total
    if total!=entry['bytes'] or digest.hexdigest()!=entry['sha256']:raise ValueError('Public artifact checksum mismatch: '+entry['name'])
    temporary.replace(path)
    return {'name':entry['name'],'status':'downloaded','bytes':entry['bytes']}


def probe_dependencies():
    # Reuse previously verified isolated CPU packages when they are already here.
    # A subprocess prevents partial imports from contaminating a later install.
    program='import sys,importlib; from pathlib import Path; root=Path(sys.argv[1]); parts='+repr(RUNTIME_PARTS)+'; [sys.path.insert(0,str(root/"work"/p)) for p in parts]; [importlib.import_module(p) for p in ["torch","numpy","cv2","PIL","safetensors.torch","einops","addict","omegaconf","yaml"]]'
    result=subprocess.run([sys.executable,'-c',program,str(ROOT)],cwd=ROOT,capture_output=True,text=True,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'},timeout=90)
    return result.returncode==0


def install_dependencies():
    DEPENDENCIES.mkdir(parents=True,exist_ok=True)
    temporary=ROOT/'work/joint-depth-install-temp';temporary.mkdir(parents=True,exist_ok=True)
    env={**os.environ,'TMP':str(temporary),'TEMP':str(temporary),'TMPDIR':str(temporary),'PIP_DISABLE_PIP_VERSION_CHECK':'1'}
    command=[sys.executable,'-m','pip','--isolated','install','--target',str(DEPENDENCIES),'--upgrade','--no-cache-dir','--index-url','https://pypi.org/simple','--extra-index-url','https://download.pytorch.org/whl/cpu','--report',str(ROOT/'work/da3-model/dependencies-installed.json'),'-r',str(ROOT/'scripts/requirements-imo3d-joint-depth.txt')]
    subprocess.run(command,cwd=ROOT,env=env,check=True)


def verify_model_runtime():
    for part in RUNTIME_PARTS:sys.path.insert(0,str(ROOT/'work'/part))
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
    spec=importlib.util.spec_from_file_location('imo3d_joint_runtime',ROOT/'scripts/imo3d-joint-depth.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    model=module.Model()
    return {'torch':model.torch.__version__,'modelSha256':module.MODEL_SHA,'runtimeVersion':module.VERSION}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--verify-only',action='store_true',help='Verify existing artifacts/runtime; no network downloads or installation');args=parser.parse_args()
    if sys.version_info<(3,11):raise ValueError('The isolated DA3 runtime needs Python3.11or newer; Python3.12 is verified')
    manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
    with ThreadPoolExecutor(max_workers=3) as pool:
        artifacts=list(pool.map(lambda entry:ensure_artifact(entry,args.verify_only),manifest['artifacts']))
    print(json.dumps({'event':'artifacts_ready','verified':sum(a['status']=='verified' for a in artifacts),'downloaded':sum(a['status']=='downloaded' for a in artifacts)}),flush=True)
    if not probe_dependencies():
        if args.verify_only:raise ValueError('Isolated CPU inference dependencies are incomplete; run setup without --verify-only')
        install_dependencies()
    details=verify_model_runtime()
    if not args.verify_only:
        runtime=ROOT/'work/reconstruction-runtime.json'
        if not runtime.exists():runtime.write_text(json.dumps({'python':sys.executable},indent=2))
        (ROOT/'work/da3-model/setup-manifest.json').write_text(json.dumps({'model':manifest['model'],'artifacts':artifacts,'runtime':details},indent=2))
    print(json.dumps({'event':'ready','localOnly':True,**details}),flush=True)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'event':'setup_error','message':str(error)}),file=sys.stderr);sys.exit(1)
