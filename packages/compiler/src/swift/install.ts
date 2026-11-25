// The method objects translator.ts installs on the Swift Translator's prototype, in order, and the intersection its interface extends.
import { operatorsMethods } from './operators.ts';
import { callsMethods } from './calls.ts';
import { accessMethods } from './access.ts';
import { expressionsMethods } from './expressions.ts';
import { placementMethods } from './placement.ts';
import { statementsMethods } from './statements.ts';
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
import { prototypeCallsMethods } from './prototype-calls.ts';
import { globalCallsMethods } from './global-calls.ts';
import { staticCallsMethods } from './static-calls.ts';
import { argumentsMethods } from './arguments.ts';
import { lenientMethods } from './lenient.ts';
import { checkedMethods } from './checked.ts';
import { namesMethods } from './names.ts';
import { narrowingMethods } from './narrowing.ts';
import { protocolsMethods } from './protocols.ts';
import { optionalChainsMethods } from './optional-chains.ts';
import { stateBackendMethods } from './state-backend.ts';
import { loopsMethods } from './loops.ts';
import { declarationsMethods } from './declarations.ts';
import { controlFlowMethods } from './control-flow.ts';
import { exprStatementsMethods } from './expression-statements.ts';
import { constructionMethods } from './construction.ts';
import { typeTestsMethods } from './type-tests.ts';
import { availabilityMethods } from './availability.ts';
import { assignmentMethods } from './assignment.ts';
import { literalsMethods } from './literals.ts';
import { objectClassesMethods } from './object-classes.ts';
import { fromAnyMethods } from './from-any.ts';
import { castsMethods } from './casts.ts';
import { keyPlansMethods } from './key-plans.ts';
import { classDeclMethods } from './class-declaration.ts';
import { classFieldsMethods } from './class-fields.ts';
import { classConstructorMethods } from './class-constructor.ts';
import { classAccessorsMethods } from './class-accessors.ts';
import { classMethodsMethods } from './class-methods.ts';
import { mixinsMethods } from './mixins.ts';
import { enumsMethods } from './enums.ts';
import { parametersMethods } from './parameters.ts';
import { resultsMethods } from './results.ts';
import { genericsMethods } from './generics.ts';
import { typeFactsMethods } from './type-facts.ts';
import { methodValuesMethods } from './method-values.ts';
import { membersMethods } from './members.ts';

export type Mixins = typeof operatorsMethods &
	typeof constructionMethods &
	typeof typeTestsMethods &
	typeof availabilityMethods &
	typeof assignmentMethods &
	typeof literalsMethods &
	typeof callsMethods &
	typeof prototypeCallsMethods &
	typeof globalCallsMethods &
	typeof staticCallsMethods &
	typeof accessMethods &
	typeof optionalChainsMethods &
	typeof argumentsMethods &
	typeof expressionsMethods &
	typeof lenientMethods &
	typeof checkedMethods &
	typeof namesMethods &
	typeof narrowingMethods &
	typeof protocolsMethods &
	typeof placementMethods &
	typeof statementsMethods &
	typeof stateBackendMethods &
	typeof loopsMethods &
	typeof declarationsMethods &
	typeof controlFlowMethods &
	typeof exprStatementsMethods &
	typeof classesMethods &
	typeof classDeclMethods &
	typeof classFieldsMethods &
	typeof classConstructorMethods &
	typeof classAccessorsMethods &
	typeof classMethodsMethods &
	typeof mixinsMethods &
	typeof componentMethods &
	typeof functionsMethods &
	typeof enumsMethods &
	typeof parametersMethods &
	typeof resultsMethods &
	typeof genericsMethods &
	typeof conversionMethods &
	typeof objectClassesMethods &
	typeof fromAnyMethods &
	typeof castsMethods &
	typeof keyPlansMethods &
	typeof modulesMethods &
	typeof typesMethods &
	typeof typeFactsMethods &
	typeof methodValuesMethods &
	typeof builtinMethods &
	typeof frontMethods &
	typeof loweringMethods &
	typeof typeMethods &
	typeof membersMethods;

export const mixins = [
	operatorsMethods,
	constructionMethods,
	typeTestsMethods,
	availabilityMethods,
	assignmentMethods,
	literalsMethods,
	callsMethods,
	prototypeCallsMethods,
	globalCallsMethods,
	staticCallsMethods,
	accessMethods,
	optionalChainsMethods,
	argumentsMethods,
	expressionsMethods,
	lenientMethods,
	checkedMethods,
	namesMethods,
	narrowingMethods,
	protocolsMethods,
	placementMethods,
	statementsMethods,
	stateBackendMethods,
	loopsMethods,
	declarationsMethods,
	controlFlowMethods,
	exprStatementsMethods,
	classesMethods,
	classDeclMethods,
	classFieldsMethods,
	classConstructorMethods,
	classAccessorsMethods,
	classMethodsMethods,
	mixinsMethods,
	componentMethods,
	functionsMethods,
	enumsMethods,
	parametersMethods,
	resultsMethods,
	genericsMethods,
	conversionMethods,
	objectClassesMethods,
	fromAnyMethods,
	castsMethods,
	keyPlansMethods,
	modulesMethods,
	typesMethods,
	typeFactsMethods,
	methodValuesMethods,
	builtinMethods,
	frontMethods,
	loweringMethods,
	typeMethods,
	membersMethods,
];
