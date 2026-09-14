import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import hashlib

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('setup_joint',ROOT/'scripts/setup-imo3d-joint-depth.py')
setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)


class JointSetupTests(unittest.TestCase):
    def test_only_public_https_artifact_sources_are_allowed(self):
        self.assertTrue(setup.public_artifact_url('https://huggingface.co/depth-anything/DA3-BASE/resolve/pinned/config.json'))
        self.assertTrue(setup.public_artifact_url('https://cas-bridge.xethub.hf.co/artifact'))
        for url in ['https://github.com/owner/repository','https://raw.githubusercontent.com/owner/file','http://huggingface.co/model','https://token@huggingface.co/model','https://huggingface.co.attacker.example/file']:
            self.assertFalse(setup.public_artifact_url(url))

    def test_verified_existing_artifact_does_not_use_network(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'work') as folder:
            target=Path(folder)/'model.bin';target.write_bytes(b'verified local bytes')
            entry={'name':'unit-model','target':str(target.relative_to(ROOT)),'url':'https://huggingface.co/official/pinned/file','bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
            with patch.object(setup.urllib.request,'build_opener',side_effect=AssertionError('Unexpected network')):
                self.assertEqual(setup.ensure_artifact(entry)['status'],'verified')
                target.write_bytes(b'changed')
                with self.assertRaises(ValueError):setup.ensure_artifact(entry,verify_only=True)

    def test_target_cannot_escape_repository_work(self):
        with self.assertRaises(ValueError):setup.artifact_target({'target':'../foreign-model.bin','url':'https://huggingface.co/official/pinned/file'})
        with self.assertRaises(ValueError):setup.artifact_target({'target':'scripts/overwrite.py','url':'https://huggingface.co/official/pinned/file'})

    def test_manifest_pins_only_required_sources_and_model(self):
        manifest=json.loads(setup.MANIFEST.read_text())
        sources=[entry for entry in manifest['artifacts'] if entry['target'].startswith('work/da3-python/depth_anything_3/') or entry['name']=='pyproject.toml']
        self.assertEqual(len(sources),26)
        model=next(entry for entry in manifest['artifacts'] if entry['name']=='model.safetensors')
        self.assertEqual(model['bytes'],541518028)
        self.assertEqual(model['sha256'],'e01067dc1659613083d9145a9a2547ccdbe6ccbbf83c4fe7b3e8a4e2bdae78b5')
        for entry in manifest['artifacts']:
            self.assertTrue(setup.public_artifact_url(entry['url']))
            self.assertEqual(len(entry['sha256']),64)
            self.assertFalse(any(part in entry['name'] for part in ['/app/','/export/','read_write_model.py','api_helpers.py']))


if __name__=='__main__':unittest.main()
