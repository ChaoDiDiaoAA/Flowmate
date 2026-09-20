"""Author-controlled designs added by condition review; not executable adapters."""
from functools import lru_cache
def additions():
    from coverage_critical import additions as critical
    from coverage_runtime import additions as runtime
    from coverage_supplement import additions as supplement
    return critical()+runtime()+supplement()


@lru_cache(maxsize=1)
def registered():
    out={}
    for asset in additions():
        for value in asset.get('scenarios',[asset]):
            if value['id'] in out:
                raise ValueError('Duplicate reviewed declaration')
            out[value['id']]=value
    return out
