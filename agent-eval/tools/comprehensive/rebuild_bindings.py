"""Explicit specification bindings for the freshly authored dataset.

Case version encodes ``authored revision * 1000 + source binding revision``.
Gold versions and bytes are never changed by a specification-only rebinding.
The complete byte pins are kept here so an old binding can be distinguished
from an unknown source edit instead of being silently treated as current.
"""
from copy import deepcopy

ORIGINAL_PINS = [
    {'path': 'docs/spec/00_Flowmate完整方案.md', 'bytes': 685059,
     'sha256': '85160659124e7ec40d25ef9710d6567f4468a1708c682217ac239cc298b64990'},
    {'path': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md', 'bytes': 467797,
     'sha256': 'cc159edf16e610c84b306c2b27c3bb9effc2800d8b5a24e772eba828ccc56472'}]
BINDING_2_PINS = [
    {'path': 'docs/spec/00_Flowmate完整方案.md', 'bytes': 690257,
     'sha256': 'fd6a5891d7fffb8e5e777e82b9cfa649e481787e5452130da127be0aed744b15'},
    {'path': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md', 'bytes': 470546,
     'sha256': '8b249d8003feaf307b15005696b84f9b60b073a5ffb29b2386ef4b663997933c'}]
BINDING_3_PINS = [
    {'path': 'docs/spec/00_Flowmate完整方案.md', 'bytes': 693625,
     'sha256': '144ad6ad076b8229c9fca28a33dfb40e4774d951aca2ec41d7cf40570ce664e4'},
    {'path': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md', 'bytes': 470546,
     'sha256': '8b249d8003feaf307b15005696b84f9b60b073a5ffb29b2386ef4b663997933c'}]
CURRENT_PINS = [
    {'path': 'docs/spec/00_Flowmate完整方案.md', 'bytes': 693625,
     'sha256': '144ad6ad076b8229c9fca28a33dfb40e4774d951aca2ec41d7cf40570ce664e4'},
    {'path': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md', 'bytes': 471003,
     'sha256': '09225f2fd5e9598a9083f700b71f7e55a280eecc414d63259fa190534ab54e54'}]

# Compatibility name used by the original -> binding-2 migration receipt.
PREVIOUS_PINS = ORIGINAL_PINS
CURRENT_BINDING_REVISION = 4
BINDING_PINS = {1: ORIGINAL_PINS, 2: BINDING_2_PINS, 3: BINDING_3_PINS,
                4: CURRENT_PINS}


def contract_pins(contracts):
    return [{k: contracts['documents'][name][k] for k in ('path', 'bytes', 'sha256')}
            for name in ('product', 'evaluation')]


def binding_revision(contracts):
    pins = contract_pins(contracts)
    for revision, expected in BINDING_PINS.items():
        if pins == expected:
            return revision
    raise ValueError('Specification bytes are not a registered source binding')


def case_version(author_version, contracts):
    revision = binding_revision(contracts)
    return author_version if revision == 1 else author_version * 1000 + revision


def bind_business(asset, contracts):
    result = deepcopy(asset)
    result['specRefs'] = contract_pins(contracts)
    revision = binding_revision(contracts)
    if revision >= 2:
        result.update(version=asset['version'] + revision - 1,
                      creationSpecRefs=deepcopy(ORIGINAL_PINS),
                      sourceBindingRevision=revision, authoredVersion=asset['version'])
    return result
