# ListSkillResources200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**List[ListSkillResources200ResponseItemsInner]**](ListSkillResources200ResponseItemsInner.md) |  |

## Example

```python
from openapi_client.models.list_skill_resources200_response import ListSkillResources200Response

# TODO update the JSON string below
json = "{}"
# create an instance of ListSkillResources200Response from a JSON string
list_skill_resources200_response_instance = ListSkillResources200Response.from_json(json)
# print the JSON string representation of the object
print(ListSkillResources200Response.to_json())

# convert the object into a dict
list_skill_resources200_response_dict = list_skill_resources200_response_instance.to_dict()
# create an instance of ListSkillResources200Response from a dict
list_skill_resources200_response_from_dict = ListSkillResources200Response.from_dict(list_skill_resources200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
