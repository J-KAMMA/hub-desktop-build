// src/webauthn_p256.rs の黄金値を作る。webauthn-userop.ts の encodeWebAuthnAssertion と
// @noble/curves を使う（ルートの node_modules）。実行: node generate.mts
// 出た calldata を Kairos の検証器へ eth_call すると true が返る。
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/p256";
import { encodeFunctionData, encodeAbiParameters, bytesToHex } from "viem";
import { encodeWebAuthnAssertion } from "../../../../../smart-wallet-contracts/src/webauthn-userop.ts";

const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const rpId = "desktop-wallet.hub.jkamma.com";
const priv = new Uint8Array(32).fill(0x42);
const pub = p256.getPublicKey(priv, false);
const challenge = new Uint8Array(32).fill(0x11);
const b64 = Buffer.from(challenge).toString("base64url");
const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64}","origin":"https://${rpId}","crossOrigin":false}`;
const authenticatorData = new Uint8Array([...sha(new TextEncoder().encode(rpId)), 0x05, 0, 0, 0, 1]);
const signed = new Uint8Array([...authenticatorData, ...sha(new TextEncoder().encode(clientDataJSON))]);
const sig = p256.sign(sha(signed), priv, { lowS: false, prehash: false });
const der = sig.toDERRawBytes();
const high = sig.hasHighS() ? sig : new (sig.constructor as any)(sig.r, p256.CURVE.n - sig.s);
const highDer = high.toDERRawBytes();
const enc = encodeWebAuthnAssertion({ authenticatorData, clientDataJSON, signatureDER: der });
const encHigh = encodeWebAuthnAssertion({ authenticatorData, clientDataJSON, signatureDER: highDer });
const abi = [{ type: "function", name: "validateSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }, { name: "publicKey", type: "bytes" }], outputs: [{ type: "bool" }] }] as const;
const pk = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [bytesToHex(pub.slice(1, 33)), bytesToHex(pub.slice(33))]);
const calldata = encodeFunctionData({ abi, functionName: "validateSignature", args: [bytesToHex(challenge), enc, pk] });
console.log(JSON.stringify({ qx: bytesToHex(pub.slice(1, 33)), qy: bytesToHex(pub.slice(33)), clientDataJSON, authenticatorData: bytesToHex(authenticatorData), der: bytesToHex(der), highDer: bytesToHex(highDer), enc, encHigh, calldata }, null, 1));
