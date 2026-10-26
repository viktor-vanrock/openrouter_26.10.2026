# Build context is assembled from trusted files only by gateway-agent-image.mjs.
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a
COPY runtime-lock.json /opt/prototype/agent/runtime-lock.json
RUN node --input-type=module -e 'import fs from "node:fs/promises"; import {createHash} from "node:crypto"; const lock=JSON.parse(await fs.readFile("/opt/prototype/agent/runtime-lock.json")); const r=await fetch(lock.binaryUrl,{redirect:"error",signal:AbortSignal.timeout(90000)}); if(!r.ok)throw Error("BINARY_DOWNLOAD_FAILED"); const b=Buffer.from(await r.arrayBuffer()); if(b.length>200000000 || "sha512-"+createHash("sha512").update(b).digest("base64")!==lock.binaryIntegrity)throw Error("BINARY_INTEGRITY_FAILED"); await fs.writeFile("/tmp/opencode.tgz",b);' \
 && mkdir -p /opt/prototype/opencode \
 && tar -xzf /tmp/opencode.tgz -C /opt/prototype/opencode --strip-components=2 package/bin/opencode \
 && rm /tmp/opencode.tgz \
 && chmod 755 /opt/prototype/opencode/opencode \
 && test "$(/opt/prototype/opencode/opencode --version)" = "1.18.16" \
 && addgroup -g 10001 -S prototype \
 && adduser -u 10001 -S -D -H -G prototype prototype \
 && mkdir -p /work /run/input /tmp/prototype-home \
 && chown -R 10001:10001 /work /run/input /tmp/prototype-home
COPY runner /opt/prototype/agent
ENV HOME=/tmp/prototype-home OPENCODE_DISABLE_PROJECT_CONFIG=true OPENCODE_DISABLE_DEFAULT_PLUGINS=true OPENCODE_DISABLE_EXTERNAL_SKILLS=true OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_LSP_DOWNLOAD=true
WORKDIR /work
USER 10001:10001
CMD ["sleep", "infinity"]
