## Agent Merge Broker

Before editing, every worker must claim a task with the narrowest accurate path scope. Keep the lease alive during long work. Produce focused commits and submit their immutable SHAs to the broker. Workers must not merge, rebase, push, open pull requests, or modify integration branches.

Read `.merge-broker/agent-instructions.md` for the exact command protocol. The integration owner runs `merge-broker plan`, `merge-broker integrate`, and publication commands.
