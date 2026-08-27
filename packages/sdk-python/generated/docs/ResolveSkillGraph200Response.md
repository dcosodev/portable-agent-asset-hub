# ResolveSkillGraph200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**limits** | [**ResolveSkillGraph200ResponseLimits**](ResolveSkillGraph200ResponseLimits.md) |  |
**resolved** | [**List[ResolveSkillGraph200ResponseResolvedInner]**](ResolveSkillGraph200ResponseResolvedInner.md) |  |
**root** | [**ResolveSkillGraph200ResponseResolvedInnerParentOneOf**](ResolveSkillGraph200ResponseResolvedInnerParentOneOf.md) |  |

## Example

```python
from openapi_client.models.resolve_skill_graph200_response import ResolveSkillGraph200Response

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveSkillGraph200Response from a JSON string
resolve_skill_graph200_response_instance = ResolveSkillGraph200Response.from_json(json)
# print the JSON string representation of the object
print(ResolveSkillGraph200Response.to_json())

# convert the object into a dict
resolve_skill_graph200_response_dict = resolve_skill_graph200_response_instance.to_dict()
# create an instance of ResolveSkillGraph200Response from a dict
resolve_skill_graph200_response_from_dict = ResolveSkillGraph200Response.from_dict(resolve_skill_graph200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
