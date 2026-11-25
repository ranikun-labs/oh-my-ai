# FX-INS-120 legacy directory link

A runtime skills root that is a symlink to the repository skills/ directory would expose core/ and library/ as bogus Skills. Doctor warns, leaves the link untouched, and does not fail strict mode for it.
