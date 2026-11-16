# Prepare a release

Check everything, package the four packages, verify the package, and publish only after Randy approves.

## When this happens
- I approve a release.

## Make sure
- The tests pass.

## Steps
1. Package the result.
2. Verify the package.
3. Ask randy to approve the release.
4. Publish the package to npm.

## Keep
- The test results.
- The package.
- The release evidence.

## Custom checks

### The README quick start works
```sh
bash scripts/smoke-quickstart.sh
```

### The generated spec files are current
```sh
cp -r spec /tmp/spec-committed
npm run generate:spec
diff -r /tmp/spec-committed spec
```

### The packages install outside the repository
```sh
npm run publish:dry-run
```
