const required = ["LOCAL_RUNNER_SIGNING_PRIVATE_KEY", "LOCAL_RUNNER_SIGNING_PUBLIC_KEY", "LOCAL_RUNNER_PYTHON_IMAGE", "LOCAL_RUNNER_NODE_IMAGE"];
const failures = required.filter((name) => !process.env[name]).map((name) => `${name}: missing`);
for (const name of ["LOCAL_RUNNER_PYTHON_IMAGE", "LOCAL_RUNNER_NODE_IMAGE"]) {
  const value = process.env[name] ?? "";
  if (value && !/^[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(value)) failures.push(`${name}: immutable digest required`);
}
if (failures.length) { console.error(`Local Runner production readiness failed\n${failures.join("\n")}`); process.exit(1); }
console.log("Local Runner production readiness: configuration gate passed");
