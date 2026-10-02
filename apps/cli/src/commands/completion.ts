import { Argument, Command } from "@commander-js/extra-typings";
import { guard } from "../lib/actions.js";
import { helpText } from "../lib/help.js";
import { paths, root, tree } from "../lib/tree.js";

const shells = ["bash", "zsh", "fish", "powershell"] as const;
type Shell = (typeof shells)[number];

function bash(table: Map<string, string[]>) {
  const cases = [...table].map(([path, words]) => `    "${path}") echo "${words.join(" ")}" ;;`).join("\n");
  return `# dispatch completion for bash. Add to ~/.bashrc:
#   source <(dispatch completion bash)
_dispatch_words() {
  case "$1" in
${cases}
  esac
}
_dispatch() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" word candidates
  for word in "\${COMP_WORDS[@]:1:$((COMP_CWORD - 1))}"; do
    [[ "$word" == -* ]] && continue
    candidates=" $(_dispatch_words "$path") "
    [[ "$candidates" == *" $word "* ]] && path="\${path:+$path }$word"
  done
  COMPREPLY=($(compgen -W "$(_dispatch_words "$path")" -- "$cur"))
}
complete -o default -F _dispatch dispatch
`;
}

function zsh(table: Map<string, string[]>) {
  return `#compdef dispatch
# dispatch completion for zsh. Add to ~/.zshrc:
#   source <(dispatch completion zsh)
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }
autoload -U +X bashcompinit && bashcompinit
${bash(table)
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n")}`;
}

function fish(table: Map<string, string[]>) {
  const cases = [...table]
    .map(([path, words]) => `        case '${path}'\n            printf '%s\\n' ${words.map((word) => `'${word}'`).join(" ")}`)
    .join("\n");
  return `# dispatch completion for fish. Save as ~/.config/fish/completions/dispatch.fish:
#   dispatch completion fish > ~/.config/fish/completions/dispatch.fish
function __dispatch_words
    switch "$argv[1]"
${cases}
    end
end
function __dispatch_complete
    set -l path ''
    for word in (commandline -opc)[2..-1]
        string match -q -- '-*' $word; and continue
        if contains -- $word (__dispatch_words "$path")
            set path (string trim -- "$path $word")
        end
    end
    __dispatch_words "$path"
end
complete -c dispatch -a '(__dispatch_complete)'
`;
}

function powershell(table: Map<string, string[]>) {
  const entries = [...table].map(([path, words]) => `    '${path}' = @(${words.map((word) => `'${word}'`).join(", ")})`).join("\n");
  return `# dispatch completion for PowerShell. Add to $PROFILE:
#   dispatch completion powershell | Out-String | Invoke-Expression
$__dispatchWords = @{
${entries}
}
Register-ArgumentCompleter -Native -CommandName dispatch -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $path = ''
    foreach ($element in $commandAst.CommandElements | Select-Object -Skip 1) {
        $word = $element.ToString()
        if ($word -eq $wordToComplete -or $word.StartsWith('-')) { continue }
        if ($__dispatchWords[$path] -contains $word) { $path = ($path + ' ' + $word).Trim() }
    }
    $__dispatchWords[$path] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
`;
}

export function script(shell: Shell, table: Map<string, string[]>) {
  return { bash, zsh, fish, powershell }[shell](table);
}

export const completion = new Command("completion")
  .description("Print a shell completion script")
  .addArgument(new Argument("[shell]", "Shell").choices(shells).default("bash" as Shell))
  .addHelpText(
    "after",
    helpText({
      output: "A completion script on stdout.",
      examples: [
        "source <(dispatch completion bash)",
        "source <(dispatch completion zsh)",
        "dispatch completion fish > ~/.config/fish/completions/dispatch.fish",
        "dispatch completion powershell | Out-String | Invoke-Expression",
      ],
    }),
  )
  .action(async (shell, _options, command) => {
    await guard(command, "completion_error", async () => {
      const top = tree(root(command));
      const globals = top.options.map((option) => option.flags.split(/[ ,|]+/).find((part) => part.startsWith("--"))!).filter(Boolean);
      process.stdout.write(script(shell, paths({ ...top, options: [] }, globals)));
    });
  });
