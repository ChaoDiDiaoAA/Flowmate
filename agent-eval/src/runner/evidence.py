"""Trusted runner boundary: JSON claims cannot mint verified product observations.

Registry values are trusted adapter callbacks, installed by the runner, accepting
(manifest, decoded_artifacts). They must attest provenance using runner-owned run
records, not a model-provided adapter name. No adapters are registered here.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

_TOKEN = object()


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


class VerifiedObservation(dict):
    def __init__(self, value, token):
        if token is not _TOKEN:
            raise ValueError('trusted loader required')
        super().__init__(deepcopy(value))
        self._seal = _digest(value)


def is_verified(value):
    return isinstance(value, VerifiedObservation) and value._seal == _digest(value)


def load_evidence(run_root: Path, manifest: dict, trusted_adapters: dict) -> dict:
    root = Path(run_root).resolve(strict=True)
    source = manifest.get('source', {})
    identity = {key: manifest[key] for key in ('caseId', 'caseVersion')}
    if source.get('kind') != 'product_run' or not source.get('runId'):
        raise ValueError('product run identity required')
    adapter = trusted_adapters.get(source.get('adapterVersion'))
    if not callable(adapter):
        raise ValueError('unregistered trusted adapter')
    decoded = {}
    evidence = manifest.get('evidence')
    if not isinstance(evidence, list) or not evidence:
        raise ValueError('artifact evidence required')
    for item in evidence:
        relative = item['artifact'].replace('\\', '/')
        if relative.startswith('/') or ':' in relative or '..' in relative.split('/'):
            raise ValueError('artifact path must be contained')
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('artifact escapes controlled run root')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('artifact hash mismatch')
        value = json.loads(raw)
        if any(value.get(k) != v for k, v in identity.items()) or value.get('source') != source:
            raise ValueError('artifact run/case/adapter identity mismatch')
        if relative in decoded:
            raise ValueError('duplicate artifact')
        decoded[relative] = value
    if adapter(manifest, deepcopy(decoded)) is not True:
        raise ValueError('adapter did not attest runner provenance')
    primary = decoded.get(manifest.get('observationArtifact'))
    if not primary or not isinstance(primary.get('observation'), dict):
        raise ValueError('observation must come from verified artifact bytes')
    value = {**identity, 'source': deepcopy(source), 'evidence': deepcopy(evidence),
             'observation': primary['observation']}
    # Control envelopes must pass this same boundary independently.
    control = manifest.get('normalControl')
    if control is not None:
        if not is_verified(control):
            raise ValueError('normal control must be independently verified')
        value['normalControl'] = deepcopy(dict(control))
    return VerifiedObservation(value, _TOKEN)
