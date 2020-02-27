#!/bin/bash

docker inspect riot-desktop-dockerbuild 2> /dev/null > /dev/null
if [ $? != 0 ]; then
    echo "Docker image riot-desktop-builder not found. Have you run yarn run docker:setup?"
    exit 1
fi

# Taken from https://www.electron.build/multi-platform-build#docker
docker run --rm -ti \
 --env-file <(env | grep -iE '^BUILDKITE_API_KEY=') \
 --env ELECTRON_CACHE="/root/.cache/electron" \
 --env ELECTRON_BUILDER_CACHE="/root/.cache/electron-builder" \
 -v ${PWD}:/project \
 -v ${PWD}/docker/node_modules:/project/node_modules \
 -v ${PWD}/docker/.hak:/project/.hak \
 -v ~/.cache/electron:/root/.cache/electron \
 -v ~/.cache/electron-builder:/root/.cache/electron-builder \
 riot-desktop-dockerbuild "$@"
