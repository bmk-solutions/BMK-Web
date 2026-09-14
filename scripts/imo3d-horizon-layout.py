"""Local HorizonNet weight inference for panorama floor/ceiling boundaries.

Network assembled from the published architecture and tensor shapes; no remote
Python code is loaded. Checkpoints use PyTorch's restricted weights-only loader.
Angles are relative to a level camera; no output is a measurement in metres.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
VERSION='horizonnet-st3d-v1'
sys.path.insert(0,os.environ.get('IMO3D_LAYOUT_PACKAGES',str(ROOT/'work/layout-python-verified')))
import numpy as np
from PIL import Image,ImageDraw
import torch
from torch import nn
from torch.nn import functional as F
from torchvision.models import resnet50

class WrapWidth(nn.Module):
    def __init__(self,padding):
        super().__init__();self.padding=padding
    def forward(self,x):
        return F.pad(x,(self.padding,self.padding,0,0),mode='circular')

def wrap_convolutions(module):
    for name,child in list(module.named_children()):
        if isinstance(child,nn.Conv2d) and child.padding[1]:
            width=child.padding[1];child.padding=(child.padding[0],0)
            setattr(module,name,nn.Sequential(WrapWidth(width),child))
        else:wrap_convolutions(child)

class Backbone(nn.Module):
    def __init__(self):
        super().__init__();self.encoder=resnet50(weights=None)
        wrap_convolutions(self.encoder)
    def forward(self,x):
        e=self.encoder;x=e.maxpool(e.relu(e.bn1(e.conv1(x))));values=[]
        for block in [e.layer1,e.layer2,e.layer3,e.layer4]:
            x=block(x);values.append(x)
        return values

class HeightLayer(nn.Module):
    def __init__(self,source,target):
        super().__init__()
        self.layers=nn.Sequential(nn.Sequential(WrapWidth(1),nn.Conv2d(source,target,3,stride=(2,1),padding=(1,0))),nn.BatchNorm2d(target),nn.ReLU(inplace=True))
    def forward(self,x):return self.layers(x)

class HeightReduction(nn.Module):
    def __init__(self,channels):
        super().__init__();widths=[channels,channels//2,channels//2,channels//4,channels//8]
        self.layer=nn.Sequential(*[HeightLayer(a,b) for a,b in zip(widths,widths[1:])])
    def forward(self,x):return self.layer(x)

class HorizontalFeatures(nn.Module):
    def __init__(self):
        super().__init__();self.ghc_lst=nn.ModuleList([HeightReduction(c) for c in [256,512,1024,2048]])
    def forward(self,features):
        result=[]
        for x,reduction in zip(features,self.ghc_lst):
            x=reduction(x).flatten(1,2);factor=256//x.shape[-1]
            x=F.pad(x,(1,1),mode='circular')
            x=F.interpolate(x,size=256+2*factor,mode='linear',align_corners=False)[...,factor:-factor]
            result.append(x)
        return torch.cat(result,dim=1)

class BoundaryNetwork(nn.Module):
    def __init__(self):
        super().__init__();self.feature_extractor=Backbone();self.reduce_height_module=HorizontalFeatures()
        self.bi_rnn=nn.LSTM(1024,512,num_layers=2,dropout=.5,bidirectional=True)
        self.linear=nn.Linear(1024,12)
    def forward(self,image):
        mean=image.new_tensor([.485,.456,.406]).view(1,3,1,1);std=image.new_tensor([.229,.224,.225]).view(1,3,1,1)
        x=self.reduce_height_module(self.feature_extractor((image-mean)/std)).permute(2,0,1)
        x=self.bi_rnn(x)[0];x=self.linear(x)
        x=x.reshape(x.shape[0],x.shape[1],3,4).permute(1,2,0,3).flatten(2)
        return x[:,1:],x[:,:1].sigmoid()

def load_network(weights):
    checkpoint=torch.load(weights,map_location='cpu',weights_only=True)
    state=checkpoint.get('state_dict',checkpoint);model=BoundaryNetwork()
    if not any(k.startswith('feature_extractor.encoder.fc.') for k in state):model.feature_extractor.encoder.fc=nn.Identity()
    model.load_state_dict(state,strict=True);model.eval();return model

def predict(model,path):
    image=Image.open(path).convert('RGB').resize((1024,512),Image.Resampling.BICUBIC)
    array=np.asarray(image,dtype=np.float32)/255
    tensor=torch.from_numpy(array).permute(2,0,1).unsqueeze(0)
    with torch.inference_mode():boundary,corners=model(tensor)
    values=boundary[0].numpy()
    if not np.isfinite(values).all() or np.any(values[0]>=values[1]):raise ValueError('Invalid predicted floor/ceiling order')
    return {'floorBoundaryRadians':values[1].tolist(),'ceilingBoundaryRadians':values[0].tolist(),'cornerProbabilities':corners[0,0].numpy().tolist()},image

def file_digest(path):
    digest=hashlib.sha256()
    with open(path,'rb') as handle:
        for block in iter(lambda:handle.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

def valid_profile(profile):
    if not isinstance(profile,dict):return False
    try:
        floor=np.asarray(profile['floorBoundaryRadians'],dtype=float)
        ceiling=np.asarray(profile['ceilingBoundaryRadians'],dtype=float)
        corners=np.asarray(profile['cornerProbabilities'],dtype=float)
        return (floor.shape==ceiling.shape==corners.shape==(1024,) and
                np.isfinite(floor).all() and np.isfinite(ceiling).all() and np.isfinite(corners).all() and
                (floor>0).all() and (floor<np.pi/2).all() and (ceiling<0).all() and (ceiling>-np.pi/2).all() and
                (corners>=0).all() and (corners<=1).all())
    except (KeyError,ValueError,TypeError):return False

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True);parser.add_argument('--weights',default=os.environ.get('IMO3D_LAYOUT_WEIGHTS',str(ROOT/'work/layout-model/resnet50_rnn__st3d.pth')));parser.add_argument('--limit',type=int,default=0);parser.add_argument('--diagnostics')
    args=parser.parse_args();torch.set_num_threads(8)
    revision=file_digest(args.weights)
    expected=os.environ.get('IMO3D_LAYOUT_WEIGHTS_SHA256','09c3636efb7d07f244e9fa99ed463136ea611e193d24d9ef2980b55d764b7233')
    if revision!=expected:raise ValueError('Room layout weights checksum does not match the configured model')
    model=None;scenes=json.loads(Path(args.input).read_text(encoding='utf-8-sig'))['scenes'];profiles={};errors=[]
    cache_dir=Path(os.environ.get('IMO3D_ANALYSIS_CACHE_DIR',str(Path(args.output).parent/'analysis-cache')))/'boundaries'
    cache_dir.mkdir(parents=True,exist_ok=True)
    if args.limit:scenes=scenes[:args.limit]
    if args.diagnostics:Path(args.diagnostics).mkdir(parents=True,exist_ok=True)
    for index,scene in enumerate(scenes):
        try:
            digest=file_digest(scene['path']);cache_key=hashlib.sha256((VERSION+revision+digest).encode()).hexdigest();cache=cache_dir/(cache_key+'.json');profile=None
            try:
                cached=json.loads(cache.read_text(encoding='utf-8'))
                if cached.get('version')==VERSION and cached.get('imageSha256')==digest and cached.get('modelSha256')==revision and valid_profile(cached.get('profile')):profile=cached['profile']
            except (OSError,ValueError,TypeError):pass
            if profile is None:
                if model is None:model=load_network(args.weights)
                profile,image=predict(model,scene['path'])
                if not valid_profile(profile):raise ValueError('Predicted room boundary is not a valid level-camera profile')
                cache.write_text(json.dumps({'version':VERSION,'imageSha256':digest,'modelSha256':revision,'profile':profile}),encoding='utf-8')
            elif args.diagnostics:image=Image.open(scene['path']).convert('RGB').resize((1024,512),Image.Resampling.BICUBIC)
            profiles[scene['id']]=profile
            if args.diagnostics:
                draw=ImageDraw.Draw(image)
                for name,color in [('floorBoundaryRadians','#00ff77'),('ceilingBoundaryRadians','#ff5050')]:
                    points=[(x,float(value)/np.pi*512+256) for x,value in enumerate(profile[name])];draw.line(points,fill=color,width=3)
                image.save(Path(args.diagnostics)/(str(index)+'.png'))
        except Exception as error:errors.append({'id':scene['id'],'error':str(error)})
        print(json.dumps({'event':'progress','stage':'boundaries','completed':index+1,'total':len(scenes)}),flush=True)
    output={'version':1,'method':'horizonnet-st3d','modelSha256':revision,'scale':'camera_height','profiles':profiles,'errors':errors}
    target=Path(args.output);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(output),encoding='utf-8')
    if errors:raise SystemExit(2)

if __name__=='__main__':main()
