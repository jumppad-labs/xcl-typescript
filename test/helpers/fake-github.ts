/**
 * A fake of GitHub's release API, for the tests that refuse a tampered release
 * or an untrusted key.
 *
 * It answers the two routes the engine reads, the release by tag and each asset
 * by id, the way GitHub's REST API does: `GET /repos/<owner>/<repo>/releases/tags/<tag>`
 * answers the release JSON whose assets point back at this server, and
 * `GET /repos/<owner>/<repo>/releases/assets/<id>` answers an asset's bytes to a
 * request accepting `application/octet-stream` and its JSON otherwise.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One asset of a release, by name. */
export type ReleaseAsset = readonly [name: string, data: Uint8Array];

/** One release served over HTTP on a local port. */
export class FakeGitHub {
  /** The URL of each request, in the order they arrived. */
  readonly requests: string[] = [];

  private constructor(
    private readonly server: Server,
    readonly repository: string,
    readonly tag: string,
    private readonly assets: readonly ReleaseAsset[],
  ) {}

  /** Starts a server for `repository` at `tag` holding `assets`, in that order. */
  static async start(repository: string, tag: string, assets: readonly ReleaseAsset[]): Promise<FakeGitHub> {
    let fake: FakeGitHub | undefined;
    const server = createServer((request, response) => {
      fake?.answer(request, response);
    });
    fake = new FakeGitHub(server, repository, tag, assets);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    return fake;
  }

  /** The base URL, given to the registry as its API. */
  get url(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** The path the asset with this id is served at. */
  assetPath(id: number): string {
    return `/repos/${this.repository}/releases/assets/${id}`;
  }

  /** The path the release is served at. */
  get releasePath(): string {
    return `/repos/${this.repository}/releases/tags/${this.tag}`;
  }

  /** The id the asset named `name` is served under. */
  assetId(name: string): number {
    return this.assets.findIndex(([assetName]) => assetName === name) + 1;
  }

  /** Stops listening and closes the connections the engine's HTTP client keeps open. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? "";
    this.requests.push(path);
    if (path === this.releasePath) {
      this.respond(response, "application/json", JSON.stringify(this.release()));
      return;
    }

    const assetPrefix = `/repos/${this.repository}/releases/assets/`;
    if (path.startsWith(assetPrefix)) {
      this.answerAsset(request, response, Number.parseInt(path.slice(assetPrefix.length), 10));
      return;
    }
    this.notFound(response);
  }

  private release(): object {
    return {
      tag_name: this.tag,
      draft: false,
      assets: this.assets.map(([name], index) => ({
        id: index + 1,
        name,
        url: this.url + this.assetPath(index + 1),
        content_type: "application/octet-stream",
      })),
    };
  }

  private answerAsset(request: IncomingMessage, response: ServerResponse, id: number): void {
    const asset = this.assets[id - 1];
    if (asset === undefined) {
      this.notFound(response);
      return;
    }

    const [name, data] = asset;
    if (request.headers.accept !== "application/octet-stream") {
      this.respond(response, "application/json", JSON.stringify({ id, name }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length });
    response.end(data);
  }

  private respond(response: ServerResponse, contentType: string, body: string): void {
    response.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  }

  private notFound(response: ServerResponse): void {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"message":"Not Found"}');
  }
}
