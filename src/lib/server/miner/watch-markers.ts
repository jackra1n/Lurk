export const diffWatchedLogins = (previous: ReadonlySet<string>, next: ReadonlySet<string>) => {
	const started = Array.from(next)
		.filter((login) => !previous.has(login))
		.sort((left, right) => left.localeCompare(right));
	const stopped = Array.from(previous)
		.filter((login) => !next.has(login))
		.sort((left, right) => left.localeCompare(right));

	return { started, stopped };
};
