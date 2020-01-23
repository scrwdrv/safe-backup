export default class Prompt {
    private rl;
    private getRl;
    private ask;
    private end;
    questions: {
        getInput: (inputs?: any[]) => Promise<string[]>;
        getOutput: (outputs?: any[]) => Promise<string[]>;
        getWatch: () => Promise<number>;
        getSavePassowrd: () => Promise<boolean>;
        getIgnore: (ignore?: any[]) => any;
        setPassword: () => Promise<string>;
        getPassword: () => Promise<string>;
        getYn: (question: string) => Promise<boolean>;
    };
}
