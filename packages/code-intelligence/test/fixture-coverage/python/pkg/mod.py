# One relative import (resolves), one absolute-dotted intra-package import
# (resolves), one external stdlib import (stays unresolved) — see
# coverage-invariant.test.ts's CORPUS row for the exact expected counts this
# file exists to produce.
from .base import build
import pkg.base
import os


def run():
    return build()
