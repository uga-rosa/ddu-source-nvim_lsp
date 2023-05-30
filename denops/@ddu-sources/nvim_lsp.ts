import {
  BaseSource,
  Context,
  Item,
} from "https://deno.land/x/ddu_vim@v2.8.6/types.ts#^";
import { Denops } from "https://deno.land/x/ddu_vim@v2.8.6/deps.ts#^";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.4.1/file.ts#^";
import { Location, LocationLink } from "npm:vscode-languageserver-types@3.17.3";

const SUPPORTED_METHODS = {
  "textDocument/declaration": "textDocument/declaration",
  "textDocument/definition": "textDocument/definition",
  "textDocument/typeDefinition": "textDocument/typeDefinition",
  "textDocument/implementation": "textDocument/implementation",
  "textDocument/references": "textDocument/references",
} as const satisfies Record<string, string>;

function isSupportedMethod(
  method: string,
): method is typeof SUPPORTED_METHODS[keyof typeof SUPPORTED_METHODS] {
  return Object.values(SUPPORTED_METHODS).some((m) => method === m);
}

function toLocation(loc: Location | LocationLink): Location {
  if ("uri" in loc && "range" in loc) {
    return loc;
  } else {
    return {
      uri: loc.targetUri,
      range: loc.targetSelectionRange,
    };
  }
}

function locationToItem(location: Location): Item<ActionData> {
  const { uri, range } = location;
  const path = uri.startsWith("file:") ? new URL(uri).pathname : uri;
  const { line, character } = range.start;
  const [lineNr, col] = [line + 1, character + 1];
  return {
    word: path,
    display: `${path}:${lineNr}:${col}`,
    action: { path, lineNr, col },
  };
}

function isDenoUriWithFragment(location: Location) {
  const { uri } = location;
  /**
   * Workaround. https://github.com/denoland/deno/issues/19304
   * filter deno virtual buffers with udd fragments
   * #(^|~|<|=)
   */
  return /^deno:.*%23(%5E|%7E|%3C|%3D)/.test(uri);
}

type Params = {
  method: string;
};

type Response = {
  clientId: number;
  result: unknown;
}[];

export class Source extends BaseSource<Params> {
  kind = "file";

  gather(args: {
    denops: Denops;
    sourceParams: Params;
    context: Context;
  }): ReadableStream<Item<ActionData>[]> {
    const { denops, sourceParams: { method }, context } = args;
    const { definitionHandler, referencesHandler } = this;

    return new ReadableStream({
      async start(controller) {
        if (!isSupportedMethod(method)) {
          console.log(`Unsupported method: ${method}`);
          controller.close();
          return;
        }

        const response = await denops.eval(
          `luaeval("require'ddu_nvim_lsp'.request('${method}', ${context.bufNr}, ${context.winId})")`,
        ) as Response | null;

        if (response === null) {
          controller.close();
          return;
        }

        switch (method) {
          case SUPPORTED_METHODS["textDocument/declaration"]:
          case SUPPORTED_METHODS["textDocument/definition"]:
          case SUPPORTED_METHODS["textDocument/typeDefinition"]:
          case SUPPORTED_METHODS["textDocument/implementation"]: {
            const items = definitionHandler(response);
            controller.enqueue(items);
            break;
          }
          case SUPPORTED_METHODS["textDocument/references"]: {
            const items = referencesHandler(response);
            controller.enqueue(items);
            break;
          }
          default: {
            method satisfies never;
          }
        }

        controller.close();
      },
    });
  }

  definitionHandler(
    response: Response,
  ): Item<ActionData>[] {
    return response.flatMap(({ result }) => {
      /**
       * References:
       * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_declaration
       * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_definition
       * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_typeDefinition
       * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_implementation
       */
      const locations = result as
        | Location
        | Location[]
        | LocationLink[];

      if (!Array.isArray(locations)) {
        return [locations];
      } else {
        return locations.map(toLocation);
      }
    }).filter((location) => {
      return !isDenoUriWithFragment(location);
    }).map(locationToItem);
  }

  referencesHandler(
    response: Response,
  ): Item<ActionData>[] {
    return response.flatMap(({ result }) => {
      /**
       * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_references
       */
      const locations = result as Location[];
      return locations;
    }).filter((location) => {
      return !isDenoUriWithFragment(location);
    }).map(locationToItem);
  }

  params(): Params {
    return {
      method: "",
    };
  }
}
