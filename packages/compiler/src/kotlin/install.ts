// The method objects translator.ts installs on the Kotlin Translator's prototype, in order, and the intersection its interface extends.
import { operatorsMethods } from './operators.ts';
import { callsMethods } from './calls.ts';
import { expressionsMethods } from './expressions.ts';
import { placementMethods } from './placement.ts';
import { statementsMethods } from './statements.ts';
import { overridesMethods } from './overrides.ts';
import { classesMethods } from './classes.ts';
import { componentMethods } from './components.ts';
import { functionsMethods } from './functions.ts';
import { conversionMethods } from './conversion.ts';
import { modulesMethods } from './modules.ts';
import { typesMethods } from './types.ts';
import { builtinMethods } from './builtins.ts';
import { frontMethods } from '../semantics/translator-methods.ts';
import { loweringMethods } from '../semantics/lowering-methods.ts';
import { typeMethods } from '../semantics/type-methods.ts';
import { argumentsMethods } from './arguments.ts';
import { prototypeCallsMethods } from './prototype-calls.ts';
import { globalCallsMethods } from './global-calls.ts';
import { staticCallsMethods } from './static-calls.ts';
import { namesMethods } from './names.ts';
import { narrowingMethods } from './narrowing.ts';
import { accessMethods } from './access.ts';
import { optionalChainsMethods } from './optional-chains.ts';
import { checkedMethods } from './checked.ts';
import { loopsMethods } from './loops.ts';
import { declarationsMethods } from './declarations.ts';
import { controlFlowMethods } from './control-flow.ts';
import { exprStatementsMethods } from './expression-statements.ts';
import { stateBackendMethods } from './state-backend.ts';
import { constructionMethods } from './construction.ts';
import { typeTestsMethods } from './type-tests.ts';
import { assignmentMethods } from './assignment.ts';
import { literalsMethods } from './literals.ts';
import { keyPlansMethods } from './key-plans.ts';
import { untypedValuesMethods } from './untyped-values.ts';
import { classDeclMethods } from './class-declaration.ts';
import { classFieldsMethods } from './class-fields.ts';
import { classConstructorMethods } from './class-constructor.ts';
import { classAccessorsMethods } from './class-accessors.ts';
import { classMethodsMethods } from './class-methods.ts';
import { mixinsMethods } from './mixins.ts';
import { typeFactsMethods } from './type-facts.ts';

export type Mixins = typeof operatorsMethods &
	typeof constructionMethods &
	typeof typeTestsMethods &
	typeof assignmentMethods &
	typeof literalsMethods &
	typeof keyPlansMethods &
	typeof untypedValuesMethods &
	typeof callsMethods &
	typeof argumentsMethods &
	typeof prototypeCallsMethods &
	typeof globalCallsMethods &
	typeof staticCallsMethods &
	typeof expressionsMethods &
	typeof namesMethods &
	typeof narrowingMethods &
	typeof accessMethods &
	typeof optionalChainsMethods &
	typeof checkedMethods &
	typeof placementMethods &
	typeof statementsMethods &
	typeof loopsMethods &
	typeof declarationsMethods &
	typeof controlFlowMethods &
	typeof exprStatementsMethods &
	typeof overridesMethods &
	typeof classesMethods &
	typeof classDeclMethods &
	typeof classFieldsMethods &
	typeof classConstructorMethods &
	typeof classAccessorsMethods &
	typeof classMethodsMethods &
	typeof mixinsMethods &
	typeof componentMethods &
	typeof functionsMethods &
	typeof conversionMethods &
	typeof modulesMethods &
	typeof typesMethods &
	typeof typeFactsMethods &
	typeof stateBackendMethods &
	typeof builtinMethods &
	typeof frontMethods &
	typeof loweringMethods &
	typeof typeMethods;

export const mixins = [
	operatorsMethods,
	constructionMethods,
	typeTestsMethods,
	assignmentMethods,
	literalsMethods,
	keyPlansMethods,
	untypedValuesMethods,
	callsMethods,
	argumentsMethods,
	prototypeCallsMethods,
	globalCallsMethods,
	staticCallsMethods,
	expressionsMethods,
	namesMethods,
	narrowingMethods,
	accessMethods,
	optionalChainsMethods,
	checkedMethods,
	placementMethods,
	statementsMethods,
	loopsMethods,
	declarationsMethods,
	controlFlowMethods,
	exprStatementsMethods,
	overridesMethods,
	classesMethods,
	classDeclMethods,
	classFieldsMethods,
	classConstructorMethods,
	classAccessorsMethods,
	classMethodsMethods,
	mixinsMethods,
	componentMethods,
	functionsMethods,
	conversionMethods,
	modulesMethods,
	typesMethods,
	typeFactsMethods,
	stateBackendMethods,
	builtinMethods,
	frontMethods,
	loweringMethods,
	typeMethods,
];
