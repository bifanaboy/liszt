import { parentPort, workerData } from "node:worker_threads";
import api from "sxyprn";

const { method, args } = workerData;
parentPort.postMessage(await api.videos[method](...args));
